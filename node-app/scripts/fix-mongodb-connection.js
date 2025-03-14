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
  console.log(
    `Fixing MongoDB connection for agent ${AGENT_ID} with target IP ${TARGET_IP}`
  );

  try {
    // Find or create config file
    const configPath = await findConfigFile();

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

    // Create router name and service name
    const routerName = `mongodb-${AGENT_ID}`;
    const serviceName = `mongodb-${AGENT_ID}-service`;
    const domain = `${AGENT_ID}.${MONGO_DOMAIN}`;

    // Add the catchall router if it doesn't exist
    if (!config.tcp.routers["mongodb-catchall"]) {
      console.log("Adding MongoDB catchall router");
      config.tcp.routers["mongodb-catchall"] = {
        rule: `HostSNI(\`*.${MONGO_DOMAIN}\`)`,
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
    }

    // Add the router
    console.log(`Adding router for ${domain}`);
    config.tcp.routers[routerName] = {
      rule: `HostSNI(\`${domain}\`)`,
      entryPoints: ["mongodb"],
      service: serviceName,
      tls: {
        passthrough: true,
      },
    };

    // Add the service
    console.log(`Adding service for ${TARGET_IP}:27017`);
    config.tcp.services[serviceName] = {
      loadBalancer: {
        servers: [
          {
            address: `${TARGET_IP}:27017`,
          },
        ],
      },
    };

    // Write the updated configuration
    await fs.writeFile(configPath, yaml.stringify(config), "utf8");
    console.log(`Updated configuration at ${configPath}`);

    // Restart Traefik
    console.log("Restarting Traefik...");
    try {
      execSync("docker restart traefik");
      console.log("Traefik restarted");
    } catch (err) {
      console.error(`Failed to restart Traefik: ${err.message}`);
      console.log("You may need to restart Traefik manually");
    }

    console.log(
      `\nMongoDB connection should now be available at: ${domain}:27017`
    );
    console.log(
      `Try connecting with: mongosh "mongodb://admin:adminpassword@${domain}:27017/admin?ssl=true&authSource=admin&tlsAllowInvalidCertificates=true"`
    );
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
