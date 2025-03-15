#!/usr/bin/env node
/**
 * Fix MongoDB Connection
 *
 * This script registers the agent with the proper TLS configuration
 */

require("dotenv").config();
const fs = require("fs").promises;
const yaml = require("yaml");
const { execSync } = require("child_process");
const path = require("path");

// Configuration
const AGENT_ID = process.argv[2] || "240922b9-4d3b-4692-8d1c-1884d423092a";
const TARGET_IP = process.argv[3] || "128.140.53.203";
const TRAEFIK_CONFIG_PATH = "/etc/traefik/dynamic.yml";
const TRAEFIK_CONTAINER = "traefik";

// Try multiple possible config paths
const CONFIG_PATHS = [
  "/app/config/dynamic.yml",
  "/etc/traefik/dynamic.yml",
  "./config/dynamic.yml",
  "/opt/cloudlunacy_front/config/dynamic.yml",
  path.resolve(__dirname, "../../config/dynamic.yml"),
];

const MONGO_DOMAIN = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";

async function findConfigFile() {
  for (const configPath of CONFIG_PATHS) {
    try {
      await fs.access(configPath);
      console.log(`Found configuration at ${configPath}`);
      return configPath;
    } catch (err) {
      // Continue to next path
    }
  }

  // If we get here, no config file was found
  console.error("Could not find dynamic.yml in any of the expected locations");
  console.error("Creating a new configuration file in ./config/dynamic.yml");

  // Create directory if it doesn't exist
  await fs.mkdir("./config", { recursive: true });

  // Create a basic config file
  const basicConfig = {
    http: {
      routers: {},
      middlewares: {},
      services: {},
    },
    tcp: {
      routers: {},
      services: {},
    },
  };

  await fs.writeFile(
    "./config/dynamic.yml",
    yaml.stringify(basicConfig),
    "utf8"
  );
  return "./config/dynamic.yml";
}

async function main() {
  console.log(`Fixing MongoDB connection for agent ${AGENT_ID}...`);

  try {
    // Read the current Traefik configuration
    const configContent = await fs.readFile(TRAEFIK_CONFIG_PATH, "utf8");
    const config = yaml.parse(configContent);

    // Check if the TCP configuration exists
    if (!config.tcp) {
      console.error("TCP configuration not found in Traefik config");
      process.exit(1);
    }

    // Check if the service exists
    const serviceName = `mongodb-${AGENT_ID}-service`;
    if (!config.tcp.services[serviceName]) {
      console.log(`Service ${serviceName} not found, creating it...`);
      config.tcp.services[serviceName] = {
        loadBalancer: {
          servers: [],
        },
      };
    }

    // Update the server address
    config.tcp.services[serviceName].loadBalancer.servers = [
      { address: `${TARGET_IP}:27017` },
    ];

    console.log(
      `Updated service ${serviceName} with address ${TARGET_IP}:27017`
    );

    // Write the updated configuration back
    await fs.writeFile(TRAEFIK_CONFIG_PATH, yaml.stringify(config), "utf8");
    console.log("Traefik configuration updated successfully");

    // Restart Traefik to apply changes
    console.log("Restarting Traefik...");
    execSync(`docker restart ${TRAEFIK_CONTAINER}`);
    console.log("Traefik restarted successfully");

    console.log("MongoDB connection fix completed successfully");
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
