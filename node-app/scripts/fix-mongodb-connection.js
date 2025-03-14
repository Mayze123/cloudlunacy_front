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

// Configuration
const AGENT_ID = process.argv[2] || "240922b9-4d3b-4692-8d1c-1884d423092a";
const TARGET_IP = process.argv[3] || "128.140.53.203";
const CONFIG_PATH =
  process.env.DYNAMIC_CONFIG_PATH || "/app/config/dynamic.yml";
const MONGO_DOMAIN = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";

async function main() {
  console.log(
    `Fixing MongoDB connection for agent ${AGENT_ID} with target IP ${TARGET_IP}`
  );

  try {
    // Read the current configuration
    const configContent = await fs.readFile(CONFIG_PATH, "utf8");
    const config = yaml.parse(configContent);

    // Ensure tcp section exists
    if (!config.tcp) {
      config.tcp = { routers: {}, services: {} };
    }

    // Create router name and service name
    const routerName = `mongodb-${AGENT_ID}`;
    const serviceName = `mongodb-${AGENT_ID}-service`;
    const domain = `${AGENT_ID}.${MONGO_DOMAIN}`;

    // Add the router
    config.tcp.routers[routerName] = {
      rule: `HostSNI(\`${domain}\`)`,
      entryPoints: ["mongodb"],
      service: serviceName,
      tls: {
        passthrough: true,
      },
    };

    // Add the service
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
    await fs.writeFile(CONFIG_PATH, yaml.stringify(config), "utf8");
    console.log(`Updated configuration at ${CONFIG_PATH}`);

    // Restart Traefik
    console.log("Restarting Traefik...");
    execSync("docker restart traefik");
    console.log("Traefik restarted");

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
