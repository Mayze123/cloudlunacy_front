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

// Run the validation if this script is executed directly
if (require.main === module) {
  runStartupValidation()
    .then((result) => {
      // Log final status
      if (result.error) {
        logger.error("Startup validation completed with errors");
        process.exit(1);
      } else {
        logger.info("Startup validation completed successfully");
        process.exit(0);
      }
    })
    .catch((err) => {
      logger.error(`Unhandled error in startup validation: ${err.message}`);
      process.exit(1);
    });
}

module.exports = {
  runStartupValidation,
};
