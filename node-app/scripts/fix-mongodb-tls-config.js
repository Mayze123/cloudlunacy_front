#!/usr/bin/env node
/**
 * Fix MongoDB TLS Configuration
 *
 * This script ensures that all MongoDB routers in Traefik are properly
 * configured for TLS passthrough.
 */

require("dotenv").config();
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

async function findConfigFile() {
  for (const configPath of CONFIG_PATHS) {
    try {
      await fs.access(configPath);
      log(`Found configuration at ${configPath}`, colors.green);
      return configPath;
    } catch (err) {
      // Continue to next path
    }
  }

  log(
    "Could not find dynamic.yml in any of the expected locations",
    colors.red
  );
  return null;
}

async function fixMongoDBRouters() {
  const configPath = await findConfigFile();
  if (!configPath) {
    return false;
  }

  try {
    // Read the configuration file
    const configContent = await fs.readFile(configPath, "utf8");
    const config = yaml.parse(configContent);

    if (!config) {
      log("Failed to parse configuration file", colors.red);
      return false;
    }

    // Ensure tcp section exists
    if (!config.tcp) {
      config.tcp = { routers: {}, services: {} };
    }
    if (!config.tcp.routers) {
      config.tcp.routers = {};
    }

    // Fix all MongoDB routers
    let fixedCount = 0;
    for (const [routerName, router] of Object.entries(config.tcp.routers)) {
      if (routerName.startsWith("mongodb-")) {
        if (!router.tls || router.tls.passthrough !== true) {
          log(`Fixing TLS configuration for router ${routerName}`, colors.blue);
          router.tls = { passthrough: true };
          fixedCount++;
        }
      }
    }

    if (fixedCount > 0) {
      // Write the updated configuration
      await fs.writeFile(configPath, yaml.stringify(config), "utf8");
      log(`Updated configuration at ${configPath}`, colors.green);

      // Restart Traefik
      log("Restarting Traefik...", colors.blue);
      try {
        execSync("docker restart traefik");
        log("Traefik restarted successfully", colors.green);
      } catch (err) {
        log(`Failed to restart Traefik: ${err.message}`, colors.red);
        log("You may need to restart Traefik manually", colors.yellow);
      }

      return true;
    } else {
      log("No MongoDB router configurations needed fixing", colors.yellow);
      return true;
    }
  } catch (err) {
    log(`Error: ${err.message}`, colors.red);
    return false;
  }
}

// Main function
async function main() {
  log("MongoDB TLS Configuration Fixer", colors.bold.white);
  log("===============================", colors.bold.white);

  const fixed = await fixMongoDBRouters();

  if (fixed) {
    log("\nMongoDB router configuration has been updated", colors.green);
    log("Connection strings will now work with TLS", colors.green);
  } else {
    log("\nFailed to fix MongoDB router configuration", colors.red);
  }
}

main().catch((err) => {
  log(`Fatal error: ${err.message}`, colors.red);
  process.exit(1);
});
