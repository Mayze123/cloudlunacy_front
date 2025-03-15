#!/usr/bin/env node
/**
 * Comprehensive MongoDB Configuration Fix
 *
 * This script ensures that all MongoDB-related configuration in Traefik
 * is consistent and doesn't use TLS passthrough, since the MongoDB server
 * doesn't support TLS.
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

const MONGO_DOMAIN = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";

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
  log(
    "Fixing MongoDB router configuration for non-TLS connections...",
    colors.bold.white
  );

  // Find dynamic.yml
  const configPath = await findConfigFile();
  if (!configPath) {
    return false;
  }

  // Read the current configuration
  const configContent = await fs.readFile(configPath, "utf8");
  const config = yaml.parse(configContent);

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

  let fixedCount = 0;

  // Fix catchall router - REMOVE TLS passthrough
  if (config.tcp.routers["mongodb-catchall"]) {
    log("Updating MongoDB catchall router...", colors.blue);

    // Remove TLS passthrough
    if (config.tcp.routers["mongodb-catchall"].tls) {
      log("Removing TLS passthrough from catchall router", colors.yellow);
      delete config.tcp.routers["mongodb-catchall"].tls;
      fixedCount++;
    }
  } else {
    // Create catchall router if it doesn't exist
    log("Creating MongoDB catchall router...", colors.blue);
    config.tcp.routers["mongodb-catchall"] = {
      rule: `HostSNI(\`*.${MONGO_DOMAIN}\`)`,
      entryPoints: ["mongodb"],
      service: "mongodb-catchall-service",
    };
    fixedCount++;
  }

  // Ensure catchall service exists
  if (!config.tcp.services["mongodb-catchall-service"]) {
    log("Creating MongoDB catchall service...", colors.blue);
    config.tcp.services["mongodb-catchall-service"] = {
      loadBalancer: {
        servers: [],
      },
    };
    fixedCount++;
  }

  // Fix all other MongoDB routers (remove TLS)
  for (const [routerName, router] of Object.entries(config.tcp.routers)) {
    if (
      routerName.startsWith("mongodb-") &&
      routerName !== "mongodb-catchall"
    ) {
      log(`Checking router: ${routerName}`, colors.blue);

      if (router.tls) {
        log(`Removing TLS passthrough from ${routerName}`, colors.yellow);
        delete router.tls;
        fixedCount++;
      }
    }
  }

  // Write the updated configuration
  if (fixedCount > 0) {
    log(`Fixed ${fixedCount} MongoDB router configurations`, colors.green);
    await fs.writeFile(configPath, yaml.stringify(config), "utf8");
    log(`Updated configuration at ${configPath}`, colors.green);

    // Restart Traefik
    log("Restarting Traefik to apply changes...", colors.blue);
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
}

// Main function
async function main() {
  log("MongoDB Configuration Fixer", colors.bold.white);
  log("========================", colors.bold.white);

  const fixed = await fixMongoDBRouters();

  if (fixed) {
    log("\nMongoDB router configuration has been updated", colors.green);
    log("Connection strings will now work without TLS", colors.green);
    log("\nTest with this connection string:", colors.bold.white);
    log(
      "mongodb://admin:adminpassword@240922b9-4d3b-4692-8d1c-1884d423092a.mongodb.cloudlunacy.uk:27017/admin",
      colors.green
    );
  } else {
    log("\nFailed to fix MongoDB router configuration", colors.red);
  }
}

main().catch((err) => {
  log(`Fatal error: ${err.message}`, colors.red);
  process.exit(1);
});
