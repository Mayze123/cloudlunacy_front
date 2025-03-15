#!/usr/bin/env node
/**
 * Fix MongoDB Connection Issues
 *
 * This script diagnoses and fixes common MongoDB connection issues.
 */

const fs = require("fs").promises;
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);
const yaml = require("yaml");

// Configuration
const MONGO_PORT = 27017;
const TRAEFIK_CONTAINER = process.env.TRAEFIK_CONTAINER || "traefik";
const MONGO_DOMAIN = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
const CONFIG_PATHS = [
  "/etc/traefik/dynamic.yml",
  "/app/config/dynamic.yml",
  "./config/dynamic.yml",
  "/opt/cloudlunacy_front/config/dynamic.yml",
];
const STATIC_CONFIG_PATHS = [
  "/etc/traefik/traefik.yml",
  "/app/config/traefik.yml",
  "./config/traefik.yml",
  "/opt/cloudlunacy_front/config/traefik.yml",
];
const DOCKER_COMPOSE_PATHS = [
  "/app/docker-compose.yml",
  "./docker-compose.yml",
  "/opt/cloudlunacy_front/docker-compose.yml",
];

// ANSI color codes for output
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  bold: "\x1b[1m",
};

// Helper functions
function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function success(message) {
  log(`✓ ${message}`, colors.green);
}

function error(message) {
  log(`✗ ${message}`, colors.red);
}

function info(message) {
  log(`ℹ ${message}`, colors.blue);
}

function warning(message) {
  log(`⚠ ${message}`, colors.yellow);
}

function header(message) {
  log(`\n${message}`, colors.bold);
}

// Read a file from multiple possible paths
async function readFile(...paths) {
  for (const filePath of paths) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      info(`Successfully read file from ${filePath}`);
      return content;
    } catch (err) {
      // Try next path
    }
  }
  return null;
}

// Parse YAML content
function parseYaml(content) {
  try {
    return yaml.parse(content);
  } catch (err) {
    error(`Failed to parse YAML: ${err.message}`);
    return null;
  }
}

// Write YAML content to a file
async function writeYaml(filePath, content) {
  try {
    const yamlContent = yaml.stringify(content);
    await fs.writeFile(filePath, yamlContent, "utf8");
    success(`Successfully wrote file to ${filePath}`);
    return true;
  } catch (err) {
    error(`Failed to write file to ${filePath}: ${err.message}`);
    return false;
  }
}

// Check if MongoDB port is exposed in Traefik
async function checkMongoDBPort() {
  header("Checking MongoDB Port");

  try {
    const { stdout } = await execAsync(
      `docker port ${TRAEFIK_CONTAINER} | grep ${MONGO_PORT}`
    );
    if (stdout.trim()) {
      success(`MongoDB port ${MONGO_PORT} is exposed in Traefik`);
      return true;
    } else {
      error(`MongoDB port ${MONGO_PORT} is not exposed in Traefik`);
      return false;
    }
  } catch (err) {
    error(`Failed to check MongoDB port: ${err.message}`);
    return false;
  }
}

// Fix MongoDB port in docker-compose.yml
async function fixMongoDBPortInDockerCompose() {
  header("Fixing MongoDB Port in Docker Compose");

  // Read docker-compose.yml
  const content = await readFile(...DOCKER_COMPOSE_PATHS);
  if (!content) {
    error("Could not find docker-compose.yml");
    return false;
  }

  // Parse docker-compose.yml
  const compose = parseYaml(content);
  if (!compose) {
    error("Failed to parse docker-compose.yml");
    return false;
  }

  // Check if traefik service exists
  if (!compose.services || !compose.services.traefik) {
    error("Traefik service not found in docker-compose.yml");
    return false;
  }

  // Check if ports section exists
  if (!compose.services.traefik.ports) {
    compose.services.traefik.ports = [];
  }

  // Check if MongoDB port is already defined
  const mongoPortDefined = compose.services.traefik.ports.some(
    (port) =>
      port === `${MONGO_PORT}:${MONGO_PORT}` ||
      port === `"${MONGO_PORT}:${MONGO_PORT}"`
  );

  if (mongoPortDefined) {
    info("MongoDB port is already defined in docker-compose.yml");
  } else {
    info("Adding MongoDB port to docker-compose.yml");
    compose.services.traefik.ports.push(`"${MONGO_PORT}:${MONGO_PORT}"`);
  }

  // Write updated docker-compose.yml
  for (const filePath of DOCKER_COMPOSE_PATHS) {
    try {
      // Check if file exists
      await fs.access(filePath);

      // Create backup
      await fs.copyFile(filePath, `${filePath}.bak.${Date.now()}`);

      // Write updated file
      if (await writeYaml(filePath, compose)) {
        success(`Updated docker-compose.yml at ${filePath}`);
        return true;
      }
    } catch (err) {
      // Try next path
    }
  }

  error("Failed to update docker-compose.yml");
  return false;
}

// Check MongoDB entrypoint in static configuration
async function checkMongoDBEntrypoint() {
  header("Checking MongoDB Entrypoint");

  // Read static configuration
  const content = await readFile(...STATIC_CONFIG_PATHS);
  if (!content) {
    error("Could not find static configuration");
    return false;
  }

  // Parse static configuration
  const config = parseYaml(content);
  if (!config) {
    error("Failed to parse static configuration");
    return false;
  }

  // Check if entryPoints section exists
  if (!config.entryPoints) {
    error("entryPoints section not found in static configuration");
    return false;
  }

  // Check if MongoDB entrypoint exists
  if (
    config.entryPoints.mongodb &&
    config.entryPoints.mongodb.address === `:${MONGO_PORT}`
  ) {
    success("MongoDB entrypoint is properly configured");
    return true;
  } else {
    error("MongoDB entrypoint is not properly configured");
    return false;
  }
}

// Fix MongoDB entrypoint in static configuration
async function fixMongoDBEntrypoint() {
  header("Fixing MongoDB Entrypoint");

  // Read static configuration
  const content = await readFile(...STATIC_CONFIG_PATHS);
  if (!content) {
    error("Could not find static configuration");
    return false;
  }

  // Parse static configuration
  const config = parseYaml(content);
  if (!config) {
    error("Failed to parse static configuration");
    return false;
  }

  // Ensure entryPoints section exists
  if (!config.entryPoints) {
    config.entryPoints = {};
  }

  // Add or update MongoDB entrypoint
  config.entryPoints.mongodb = {
    address: `:${MONGO_PORT}`,
    transport: {
      respondingTimeouts: {
        idleTimeout: "1h",
      },
    },
  };

  // Write updated static configuration
  for (const filePath of STATIC_CONFIG_PATHS) {
    try {
      // Check if file exists
      await fs.access(filePath);

      // Create backup
      await fs.copyFile(filePath, `${filePath}.bak.${Date.now()}`);

      // Write updated file
      if (await writeYaml(filePath, config)) {
        success(`Updated static configuration at ${filePath}`);
        return true;
      }
    } catch (err) {
      // Try next path
    }
  }

  error("Failed to update static configuration");
  return false;
}

// Check MongoDB catchall router in dynamic configuration
async function checkMongoDBCatchallRouter() {
  header("Checking MongoDB Catchall Router");

  // Read dynamic configuration
  const content = await readFile(...CONFIG_PATHS);
  if (!content) {
    error("Could not find dynamic configuration");
    return false;
  }

  // Parse dynamic configuration
  const config = parseYaml(content);
  if (!config) {
    error("Failed to parse dynamic configuration");
    return false;
  }

  // Check if tcp section exists
  if (!config.tcp) {
    error("tcp section not found in dynamic configuration");
    return false;
  }

  // Check if routers section exists
  if (!config.tcp.routers) {
    error("tcp.routers section not found in dynamic configuration");
    return false;
  }

  // Check if catchall router exists
  if (
    config.tcp.routers["mongodb-catchall"] &&
    config.tcp.routers["mongodb-catchall"].rule ===
      `HostSNI(\`*.${MONGO_DOMAIN}\`)` &&
    config.tcp.routers["mongodb-catchall"].service ===
      "mongodb-catchall-service" &&
    config.tcp.routers["mongodb-catchall"].tls &&
    config.tcp.routers["mongodb-catchall"].tls.passthrough === true
  ) {
    success("MongoDB catchall router is properly configured");
    return true;
  } else {
    error("MongoDB catchall router is not properly configured");
    return false;
  }
}

// Fix MongoDB catchall router in dynamic configuration
async function fixMongoDBCatchallRouter() {
  header("Fixing MongoDB Catchall Router");

  // Read dynamic configuration
  const content = await readFile(...CONFIG_PATHS);
  if (!content) {
    error("Could not find dynamic configuration");
    return false;
  }

  // Parse dynamic configuration
  const config = parseYaml(content);
  if (!config) {
    error("Failed to parse dynamic configuration");
    return false;
  }

  // Ensure tcp section exists
  if (!config.tcp) {
    config.tcp = {};
  }

  // Ensure routers section exists
  if (!config.tcp.routers) {
    config.tcp.routers = {};
  }

  // Ensure services section exists
  if (!config.tcp.services) {
    config.tcp.services = {};
  }

  // Add or update catchall router
  config.tcp.routers["mongodb-catchall"] = {
    rule: `HostSNI(\`*.${MONGO_DOMAIN}\`)`,
    entryPoints: ["mongodb"],
    service: "mongodb-catchall-service",
    tls: {
      passthrough: true,
    },
  };

  // Add or update catchall service
  config.tcp.services["mongodb-catchall-service"] = {
    loadBalancer: {
      servers: [],
    },
  };

  // Write updated dynamic configuration
  for (const filePath of CONFIG_PATHS) {
    try {
      // Check if file exists
      await fs.access(filePath);

      // Create backup
      await fs.copyFile(filePath, `${filePath}.bak.${Date.now()}`);

      // Write updated file
      if (await writeYaml(filePath, config)) {
        success(`Updated dynamic configuration at ${filePath}`);
        return true;
      }
    } catch (err) {
      // Try next path
    }
  }

  error("Failed to update dynamic configuration");
  return false;
}

// Restart Traefik container
async function restartTraefik() {
  header("Restarting Traefik");

  try {
    await execAsync(`docker restart ${TRAEFIK_CONTAINER}`);
    success(`${TRAEFIK_CONTAINER} container restarted successfully`);

    // Wait for Traefik to start
    info("Waiting for Traefik to start...");
    await new Promise((resolve) => setTimeout(resolve, 5000));

    return true;
  } catch (err) {
    error(`Failed to restart ${TRAEFIK_CONTAINER}: ${err.message}`);
    return false;
  }
}

// Main function
async function main() {
  log("MongoDB Connection Fixer", colors.bold);
  log("======================", colors.bold);

  // Step 1: Check MongoDB port
  const portOk = await checkMongoDBPort();

  // Step 2: Fix MongoDB port in docker-compose.yml if needed
  let portFixed = false;
  if (!portOk) {
    portFixed = await fixMongoDBPortInDockerCompose();
  }

  // Step 3: Check MongoDB entrypoint
  const entrypointOk = await checkMongoDBEntrypoint();

  // Step 4: Fix MongoDB entrypoint if needed
  let entrypointFixed = false;
  if (!entrypointOk) {
    entrypointFixed = await fixMongoDBEntrypoint();
  }

  // Step 5: Check MongoDB catchall router
  const routerOk = await checkMongoDBCatchallRouter();

  // Step 6: Fix MongoDB catchall router if needed
  let routerFixed = false;
  if (!routerOk) {
    routerFixed = await fixMongoDBCatchallRouter();
  }

  // Step 7: Restart Traefik if any changes were made
  if (portFixed || entrypointFixed || routerFixed) {
    await restartTraefik();
  }

  // Summary
  header("Summary");

  if (portOk || portFixed) {
    success("MongoDB port is properly configured");
  } else {
    error("Failed to fix MongoDB port");
  }

  if (entrypointOk || entrypointFixed) {
    success("MongoDB entrypoint is properly configured");
  } else {
    error("Failed to fix MongoDB entrypoint");
  }

  if (routerOk || routerFixed) {
    success("MongoDB catchall router is properly configured");
  } else {
    error("Failed to fix MongoDB catchall router");
  }

  if (portOk && entrypointOk && routerOk) {
    success("MongoDB connection is already properly configured");
  } else if (portFixed || entrypointFixed || routerFixed) {
    success("MongoDB connection has been fixed");
  } else {
    error("Failed to fix MongoDB connection");
  }
}

// Run the main function
main().catch((err) => {
  error(`Fatal error: ${err.message}`);
  process.exit(1);
});
