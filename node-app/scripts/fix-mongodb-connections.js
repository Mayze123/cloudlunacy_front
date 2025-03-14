#!/usr/bin/env node
/**
 * Fix MongoDB Connection Issues
 *
 * This script fixes common MongoDB connection issues by:
 * 1. Ensuring proper TLS configuration in Traefik
 * 2. Verifying port mappings
 * 3. Restarting Traefik if needed
 */

const fs = require("fs").promises;
const yaml = require("yaml");
const { execSync } = require("child_process");
const path = require("path");

// Configuration
const CONFIG_PATHS = [
  "/etc/traefik/dynamic.yml",
  "/app/config/dynamic.yml",
  "./config/dynamic.yml",
  "/opt/cloudlunacy_front/config/dynamic.yml",
];

const DOCKER_COMPOSE_PATHS = [
  "./docker-compose.yml",
  "/app/docker-compose.yml",
  "/opt/cloudlunacy_front/docker-compose.yml",
];

// Helper functions
async function findFile(paths) {
  for (const filePath of paths) {
    try {
      await fs.access(filePath);
      return filePath;
    } catch (err) {
      // Try next path
    }
  }
  return null;
}

async function readYamlFile(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return yaml.parse(content);
  } catch (err) {
    console.error(`Error reading or parsing ${filePath}: ${err.message}`);
    return null;
  }
}

async function writeYamlFile(filePath, data) {
  try {
    const content = yaml.stringify(data);
    await fs.writeFile(filePath, content, "utf8");
    console.log(`Updated ${filePath}`);
    return true;
  } catch (err) {
    console.error(`Error writing ${filePath}: ${err.message}`);
    return false;
  }
}

function execCommand(command) {
  try {
    return execSync(command, { encoding: "utf8" });
  } catch (err) {
    console.error(`Error executing command: ${err.message}`);
    return null;
  }
}

// Fix functions
async function fixDynamicConfig() {
  console.log("Fixing Traefik dynamic configuration...");

  // Find dynamic.yml
  const configPath = await findFile(CONFIG_PATHS);
  if (!configPath) {
    console.error("Could not find dynamic.yml");
    return false;
  }

  console.log(`Found dynamic.yml at ${configPath}`);

  // Read and parse
  const config = await readYamlFile(configPath);
  if (!config) {
    return false;
  }

  // Ensure tcp section exists
  if (!config.tcp) {
    config.tcp = { routers: {}, services: {} };
  }
  if (!config.tcp.routers) {
    config.tcp.routers = {};
  }
  if (!config.tcp.services) {
    config.tcp.services = {};
  }

  // Fix catchall router
  let fixedCount = 0;

  if (config.tcp.routers["mongodb-catchall"]) {
    console.log("Fixing MongoDB catchall router");
    config.tcp.routers["mongodb-catchall"].tls = {
      passthrough: true,
    };
    fixedCount++;
  } else {
    console.log("Creating MongoDB catchall router");
    config.tcp.routers["mongodb-catchall"] = {
      rule: "HostSNI(`*.mongodb.cloudlunacy.uk`)",
      entryPoints: ["mongodb"],
      service: "mongodb-catchall-service",
      tls: {
        passthrough: true,
      },
    };

    if (!config.tcp.services["mongodb-catchall-service"]) {
      config.tcp.services["mongodb-catchall-service"] = {
        loadBalancer: {
          servers: [],
        },
      };
    }

    fixedCount++;
  }

  // Fix all agent routers
  for (const [routerName, router] of Object.entries(config.tcp.routers)) {
    if (
      routerName.startsWith("mongodb-") &&
      routerName !== "mongodb-catchall"
    ) {
      if (!router.tls || router.tls.passthrough !== true) {
        console.log(`Fixing TLS configuration for router ${routerName}`);
        router.tls = { passthrough: true };
        fixedCount++;
      }
    }
  }

  // Save updated config
  if (fixedCount > 0) {
    const saved = await writeYamlFile(configPath, config);
    if (saved) {
      console.log(`Fixed ${fixedCount} MongoDB router configurations`);
      return true;
    }
  } else {
    console.log("No TLS configuration issues found in dynamic.yml");
    return true;
  }

  return false;
}

async function fixDockerCompose() {
  console.log("Checking Docker Compose configuration...");

  // Find docker-compose.yml
  const composePath = await findFile(DOCKER_COMPOSE_PATHS);
  if (!composePath) {
    console.error("Could not find docker-compose.yml");
    return false;
  }

  console.log(`Found docker-compose.yml at ${composePath}`);

  // Read and parse
  const compose = await readYamlFile(composePath);
  if (!compose) {
    return false;
  }

  // Check Traefik port mapping
  let needsFix = false;

  if (
    compose.services &&
    compose.services.traefik &&
    compose.services.traefik.ports
  ) {
    const ports = compose.services.traefik.ports;

    // Check if 27017 port is correctly mapped
    const hasCorrectMapping = ports.some((port) => {
      return (
        port === "27017:27017" || port === 27017 || port.startsWith("27017:")
      );
    });

    if (!hasCorrectMapping) {
      console.log("Adding MongoDB port mapping to Traefik");
      ports.push("27017:27017");
      needsFix = true;
    } else {
      console.log("MongoDB port mapping is correctly configured");
    }

    // Fix any incorrect mappings (e.g., 27018:27017)
    for (let i = 0; i < ports.length; i++) {
      if (ports[i] === "27018:27017") {
        console.log(
          "Fixing incorrect MongoDB port mapping (27018:27017 -> 27017:27017)"
        );
        ports[i] = "27017:27017";
        needsFix = true;
      }
    }

    // Save if needed
    if (needsFix) {
      const saved = await writeYamlFile(composePath, compose);
      if (saved) {
        console.log("Updated Docker Compose configuration");
        return true;
      }
    } else {
      return true;
    }
  } else {
    console.error("Could not find Traefik service in docker-compose.yml");
  }

  return false;
}

async function restartTraefik() {
  console.log("Restarting Traefik to apply changes...");

  const result = execCommand("docker restart traefik");
  if (result) {
    console.log("Traefik restarted successfully");

    // Wait for Traefik to start up
    console.log("Waiting for Traefik to start up...");
    await new Promise((resolve) => setTimeout(resolve, 5000));

    return true;
  }

  return false;
}

// Main function
async function main() {
  console.log("MongoDB Connection Fixer");
  console.log("========================");

  // Step 1: Fix dynamic.yml
  const dynamicFixed = await fixDynamicConfig();

  // Step 2: Fix docker-compose.yml
  const composeFixed = await fixDockerCompose();

  // Step 3: Restart Traefik if needed
  if (dynamicFixed || composeFixed) {
    await restartTraefik();

    console.log("\nChanges applied. Try connecting to MongoDB again.");
    console.log(
      "If issues persist, run the advanced-mongo-debug.js script for detailed diagnostics."
    );
  } else {
    console.log("\nNo configuration issues found or fixed.");
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
