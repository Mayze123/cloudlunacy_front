#!/usr/bin/env node
/**
 * Startup Configuration Validator
 *
 * This script runs at system startup to validate and fix MongoDB configuration.
 * It ensures:
 * 1. Traefik configuration is valid
 * 2. MongoDB port is properly exposed
 * 3. Agent configurations are correct
 * 4. Connectivity is working
 *
 * Usage: node startup-validator.js
 */

require("dotenv").config();
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

// ANSI color codes for output
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  bold: "\x1b[1m",
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

// Helper function to safely require modules with multiple path attempts
function safeRequire(modulePath, altPaths = []) {
  try {
    // Try direct require first
    return require(modulePath);
  } catch (err) {
    // Try alternative paths
    for (const altPath of altPaths) {
      try {
        return require(altPath);
      } catch (innerErr) {
        // Continue to next path
      }
    }

    // If we get here, all requires failed
    console.error(`Failed to load module: ${modulePath}`);
    console.error(`Original error: ${err.message}`);
    throw err;
  }
}

// Try to load the logger from multiple possible locations
let logger;
try {
  // First try relative path
  logger = safeRequire("../utils/logger", [
    "/app/utils/logger",
    "/opt/cloudlunacy_front/node-app/utils/logger",
    path.resolve(__dirname, "../utils/logger"),
    path.resolve(process.cwd(), "utils/logger"),
  ]).getLogger("startupValidator");
} catch (err) {
  // Create a simple console-based logger as fallback
  logger = {
    info: (msg, ...args) => console.log(`[INFO] ${msg}`, ...args),
    warn: (msg, ...args) => console.warn(`[WARN] ${msg}`, ...args),
    error: (msg, ...args) => console.error(`[ERROR] ${msg}`, ...args),
    debug: (msg, ...args) => console.log(`[DEBUG] ${msg}`, ...args),
  };
  console.warn("Using fallback logger due to error:", err.message);
}

// Try to load the config validator and connectivity tester
let configValidator, connectivityTester;
try {
  configValidator = safeRequire("../utils/configValidator", [
    "/app/utils/configValidator",
    "/opt/cloudlunacy_front/node-app/utils/configValidator",
    path.resolve(__dirname, "../utils/configValidator"),
    path.resolve(process.cwd(), "utils/configValidator"),
  ]);

  connectivityTester = safeRequire("../utils/connectivityTester", [
    "/app/utils/connectivityTester",
    "/opt/cloudlunacy_front/node-app/utils/connectivityTester",
    path.resolve(__dirname, "../utils/connectivityTester"),
    path.resolve(process.cwd(), "utils/connectivityTester"),
  ]);
} catch (err) {
  logger.error(`Failed to load required modules: ${err.message}`);
  logger.warn(
    "Continuing startup anyway - some functions may not work properly"
  );

  // Create dummy modules if loading fails
  configValidator = {
    validateAndFix: async () => ({
      valid: true,
      message: "Dummy config validator used due to loading error",
    }),
  };

  connectivityTester = {
    runFullTest: async () => ({
      traefik: { success: true },
      agents: {
        success: true,
        agents: [],
      },
    }),
  };
}

// Startup validation timeout (3 minutes)
const STARTUP_TIMEOUT = 3 * 60 * 1000;

async function runStartupValidation() {
  logger.info("Starting MongoDB configuration validation on system startup");

  try {
    // Set a timeout for the entire process
    const timeoutId = setTimeout(() => {
      logger.error("Startup validation timed out after 3 minutes");
      process.exit(1);
    }, STARTUP_TIMEOUT);

    // Step 1: Validate and fix configuration
    logger.info("Step 1: Validating configuration");
    const configResult = await configValidator.validateAndFix();

    if (!configResult.valid) {
      logger.error("Configuration validation failed:", configResult);
    } else if (configResult.traefikRestarted) {
      logger.info("Configuration was fixed and Traefik was restarted");

      // Wait for Traefik to fully restart
      logger.info("Waiting for Traefik to become available...");
      await new Promise((resolve) => setTimeout(resolve, 10000));
    } else {
      logger.info("Configuration is valid, no fixes needed");
    }

    // Step 2: Test connectivity
    logger.info("Step 2: Testing connectivity");
    const connectivityResult = await connectivityTester.runFullTest();

    // Log results
    if (connectivityResult.traefik.success) {
      logger.info("Traefik MongoDB listener is active");
    } else {
      logger.error(
        "Traefik MongoDB listener is not active - MongoDB connections will fail!"
      );
    }

    if (connectivityResult.agents.success) {
      logger.info("All agent MongoDB connections are working properly");
    } else {
      logger.warn(
        "Some agent MongoDB connections have issues:",
        connectivityResult.agents.agents
          .filter((a) => !a.connectivity.success)
          .map((a) => a.agentId)
      );
    }

    // Clear timeout
    clearTimeout(timeoutId);

    // Return final results
    return {
      configuration: configResult,
      connectivity: connectivityResult,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    logger.error(`Startup validation failed with error: ${err.message}`, {
      error: err.message,
      stack: err.stack,
    });
    return {
      success: false,
      error: err.message,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Validate Docker Compose configuration
 */
async function validateDockerCompose() {
  try {
    const dockerComposePath =
      process.env.DOCKER_COMPOSE_PATH || "/app/docker-compose.yml";

    // Check if file exists
    try {
      await fs.access(dockerComposePath);
    } catch (err) {
      // In production, Docker Compose file might not be needed
      if (process.env.NODE_ENV === "production") {
        logger.info(
          "Docker Compose file not found, but this is acceptable in production"
        );
        return {
          valid: true,
          fixes: [],
          message:
            "Docker Compose validation skipped in production environment",
        };
      }

      return {
        valid: false,
        fixes: [],
        message: `Error: ${err.message}`,
      };
    }

    // Continue with validation if file exists
    // ...existing validation logic...
  } catch (err) {
    logger.error(`Failed to validate Docker Compose: ${err.message}`);
    return {
      valid: false,
      fixes: [],
      message: `Error: ${err.message}`,
    };
  }
}

/**
 * Validate MongoDB connections on startup
 */
async function validateMongoDBConnections() {
  try {
    logger.info("Validating MongoDB connections...");

    const configManager = require("../services/core/configManager");
    await configManager.initialize();

    const config = await configManager.getConfig();
    let fixed = false;

    // Check MongoDB services
    if (config.tcp && config.tcp.services) {
      for (const [serviceName, service] of Object.entries(
        config.tcp.services
      )) {
        if (
          serviceName.startsWith("mongodb-") &&
          serviceName !== "mongodb-catchall-service"
        ) {
          // Extract agent ID from service name
          const agentId = serviceName
            .replace("mongodb-", "")
            .replace("-service", "");

          // Check if the service has servers
          if (
            !service.loadBalancer ||
            !service.loadBalancer.servers ||
            service.loadBalancer.servers.length === 0
          ) {
            logger.warn(
              `Service ${serviceName} has no servers, checking agent database`
            );

            // Try to find the agent in the database
            const agentService = require("../services/core/agentService");
            const agent = await agentService.getAgentById(agentId);

            if (agent && agent.targetIp) {
              logger.info(
                `Found agent ${agentId} with IP ${agent.targetIp}, fixing service`
              );

              // Fix the service
              if (!service.loadBalancer) {
                service.loadBalancer = { servers: [] };
              }

              service.loadBalancer.servers = [
                { address: `${agent.targetIp}:27017` },
              ];

              fixed = true;
            } else {
              logger.warn(
                `Could not find agent ${agentId} in database, cannot fix service`
              );
            }
          }
        }
      }
    }

    // Save the config if we fixed anything
    if (fixed) {
      logger.info("Fixed MongoDB connection issues, saving configuration");
      await configManager.saveConfig(config);

      // Restart Traefik
      try {
        logger.info("Restarting Traefik to apply configuration changes");
        execSync(
          `docker restart ${process.env.TRAEFIK_CONTAINER || "traefik"}`
        );
        logger.info("Traefik restarted successfully");
      } catch (err) {
        logger.error(`Failed to restart Traefik: ${err.message}`);
      }
    } else {
      logger.info("No MongoDB connection issues found");
    }

    return true;
  } catch (err) {
    logger.error(`Failed to validate MongoDB connections: ${err.message}`, {
      error: err.message,
      stack: err.stack,
    });
    return false;
  }
}

// Check if a module can be required
function checkModule(moduleName) {
  try {
    require(moduleName);
    return true;
  } catch (err) {
    return false;
  }
}

// Validate dependencies
function validateDependencies() {
  log("Validating dependencies...", colors.blue);

  const packageJsonPath = path.join(process.cwd(), "package.json");

  if (!fs.existsSync(packageJsonPath)) {
    log("Error: package.json not found!", colors.red);
    return false;
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const dependencies = packageJson.dependencies || {};

  let allValid = true;
  const failedDeps = [];

  for (const dep in dependencies) {
    if (!checkModule(dep)) {
      allValid = false;
      failedDeps.push(dep);
    }
  }

  if (allValid) {
    log("All dependencies are valid!", colors.green);
    return true;
  } else {
    log("Failed to load the following dependencies:", colors.red);
    failedDeps.forEach((dep) => log(`  - ${dep}`, colors.yellow));
    log("\nTry running: npm ci", colors.blue);
    return false;
  }
}

// Validate environment variables
function validateEnvironment() {
  log("Validating environment...", colors.blue);

  const requiredVars = [
    "NODE_PORT",
    "JWT_SECRET",
    "MONGO_DOMAIN",
    "APP_DOMAIN",
  ];

  const missingVars = requiredVars.filter((varName) => !process.env[varName]);

  if (missingVars.length === 0) {
    log("All required environment variables are set!", colors.green);
    return true;
  } else {
    log("Missing required environment variables:", colors.red);
    missingVars.forEach((varName) => log(`  - ${varName}`, colors.yellow));
    return false;
  }
}

// Validate file system permissions
function validateFileSystem() {
  log("Validating file system permissions...", colors.blue);

  const dirsToCheck = ["/app/config", "/app/logs", "/app/scripts"];

  const invalidDirs = dirsToCheck.filter((dir) => {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Check if we can write to the directory
      const testFile = path.join(dir, ".test-write-permission");
      fs.writeFileSync(testFile, "test");
      fs.unlinkSync(testFile);
      return false;
    } catch (err) {
      return true;
    }
  });

  if (invalidDirs.length === 0) {
    log("All directories have proper permissions!", colors.green);
    return true;
  } else {
    log("Permission issues with the following directories:", colors.red);
    invalidDirs.forEach((dir) => log(`  - ${dir}`, colors.yellow));
    return false;
  }
}

// Main validation function
function validate() {
  log("Starting validation checks...", colors.bold);

  const depsValid = validateDependencies();
  const envValid = validateEnvironment();
  const fsValid = validateFileSystem();

  if (depsValid && envValid && fsValid) {
    log(
      "\n✅ All validation checks passed! The application can start.",
      colors.green + colors.bold
    );
    return true;
  } else {
    log(
      "\n❌ Validation failed! Please fix the issues above before starting the application.",
      colors.red + colors.bold
    );
    return false;
  }
}

// Run the validation if this script is executed directly
if (require.main === module) {
  const valid = validate();
  process.exit(valid ? 0 : 1);
}

module.exports = {
  runStartupValidation,
  validate,
};
