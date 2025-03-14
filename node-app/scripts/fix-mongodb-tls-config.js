#!/usr/bin/env node
/**
 * Fix MongoDB TLS Configuration
 *
 * This script updates the MongoDB router configuration to work with non-TLS MongoDB servers
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

async function fixMongoDBRouters() {
  console.log("Fixing MongoDB router configuration for non-TLS servers...");

  // Find dynamic.yml
  const configPath = await findFile(CONFIG_PATHS);
  if (!configPath) {
    console.error("Could not find dynamic.yml");
    return false;
  }

  console.log(`Found dynamic.yml at ${configPath}`);

  // Read config
  const config = await readYamlFile(configPath);
  if (!config) {
    return false;
  }

  // Ensure tcp section exists
  if (!config.tcp) {
    console.error("No TCP section found in config");
    return false;
  }

  let fixedCount = 0;

  // Fix MongoDB routers
  for (const [routerName, router] of Object.entries(config.tcp.routers)) {
    if (routerName.startsWith("mongodb-")) {
      console.log(`Checking router: ${routerName}`);

      // For non-TLS MongoDB servers, we should NOT use passthrough
      if (router.tls && router.tls.passthrough === true) {
        console.log(`Removing TLS passthrough from ${routerName}`);
        delete router.tls;
        fixedCount++;
      }
    }
  }

  if (fixedCount > 0) {
    console.log(`Fixed ${fixedCount} MongoDB routers`);

    // Save config
    const saved = await writeYamlFile(configPath, config);
    if (!saved) {
      return false;
    }

    // Restart Traefik
    console.log("Restarting Traefik to apply changes...");
    const result = execCommand("docker restart traefik");
    if (result) {
      console.log("Traefik restarted successfully");
      return true;
    } else {
      console.error("Failed to restart Traefik");
      return false;
    }
  } else {
    console.log("No MongoDB routers needed fixing");
    return true;
  }
}

// Main function
async function main() {
  console.log("MongoDB TLS Configuration Fixer");
  console.log("===============================");

  const fixed = await fixMongoDBRouters();

  if (fixed) {
    console.log("\nMongoDB router configuration fixed successfully");
    console.log(
      'Try connecting with: mongosh "mongodb://admin:adminpassword@240922b9-4d3b-4692-8d1c-1884d423092a.mongodb.cloudlunacy.uk:27017/admin"'
    );
  } else {
    console.error("\nFailed to fix MongoDB router configuration");
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
