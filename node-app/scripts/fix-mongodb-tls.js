#!/usr/bin/env node
/**
 * Fix MongoDB TLS Configuration
 *
 * This script updates the MongoDB router configuration based on whether
 * the target MongoDB server uses TLS or not.
 */

require("dotenv").config();
const fs = require("fs").promises;
const yaml = require("yaml");
const { execSync } = require("child_process");
const path = require("path");
const net = require("net");

// Configuration
const AGENT_ID = process.argv[2] || "240922b9-4d3b-4692-8d1c-1884d423092a";
const TARGET_IP = process.argv[3] || "128.140.53.203";
const MONGO_DOMAIN = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";

// Try multiple possible config paths
const CONFIG_PATHS = [
  "/app/config/dynamic.yml",
  "/etc/traefik/dynamic.yml",
  "./config/dynamic.yml",
  "/opt/cloudlunacy_front/config/dynamic.yml",
  path.resolve(__dirname, "../../config/dynamic.yml"),
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

  // If we get here, no config file was found
  log(
    "Could not find dynamic.yml in any of the expected locations",
    colors.red
  );
  log(
    "Creating a new configuration file in ./config/dynamic.yml",
    colors.yellow
  );

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

// Check if MongoDB server uses TLS
async function checkMongoDBTLS(host, port) {
  log(`Checking if MongoDB at ${host}:${port} uses TLS...`, colors.blue);

  return new Promise((resolve) => {
    // First try a direct TCP connection
    const socket = new net.Socket();
    socket.setTimeout(5000);

    socket.on("connect", () => {
      log("TCP connection successful, checking for TLS...", colors.blue);

      // Send a MongoDB ismaster command
      const isMasterCmd = Buffer.from(
        "\x3a\x00\x00\x00" + // messageLength (58 bytes)
          "\x00\x00\x00\x00" + // requestID
          "\x00\x00\x00\x00" + // responseTo
          "\xd4\x07\x00\x00" + // opCode (OP_QUERY)
          "\x00\x00\x00\x00" + // flags
          "admin.$cmd\x00" + // fullCollectionName
          "\x00\x00\x00\x00" + // numberToSkip
          "\x01\x00\x00\x00" + // numberToReturn
          "\x13\x00\x00\x00\x10ismaster\x00\x01\x00\x00\x00\x00", // query document
        "binary"
      );

      socket.write(isMasterCmd);

      // Set a timeout for the response
      const responseTimeout = setTimeout(() => {
        log(
          "No valid MongoDB response received, assuming TLS is required",
          colors.yellow
        );
        socket.destroy();
        resolve(true); // Assume TLS is required if no valid response
      }, 2000);

      socket.once("data", (data) => {
        clearTimeout(responseTimeout);

        // If we get a valid MongoDB response, TLS is not required
        if (data.length > 16) {
          // Basic check for a valid MongoDB response
          log(
            "Received valid MongoDB response without TLS, TLS is not required",
            colors.green
          );
          socket.destroy();
          resolve(false);
        } else {
          log(
            "Received invalid response, assuming TLS is required",
            colors.yellow
          );
          socket.destroy();
          resolve(true);
        }
      });
    });

    socket.on("error", (err) => {
      log(
        `TCP connection error: ${err.message}, assuming TLS is required`,
        colors.yellow
      );
      socket.destroy();
      resolve(true); // Assume TLS is required if connection fails
    });

    socket.on("timeout", () => {
      log("TCP connection timed out, assuming TLS is required", colors.yellow);
      socket.destroy();
      resolve(true); // Assume TLS is required if connection times out
    });

    socket.connect(port, host);
  });
}

async function main() {
  log(`${colors.bold}MongoDB TLS Configuration Fixer${colors.reset}`);
  log("===============================");

  const domain = `${AGENT_ID}.${MONGO_DOMAIN}`;
  log(
    `Fixing MongoDB connection for ${domain} with target IP ${TARGET_IP}`,
    colors.blue
  );

  try {
    // Check if MongoDB uses TLS
    const usesTLS = await checkMongoDBTLS(TARGET_IP, 27017);
    log(
      `MongoDB TLS detection result: ${
        usesTLS ? "TLS required" : "TLS not required"
      }`,
      colors.blue
    );

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

    // Update the catchall router if it exists
    if (config.tcp.routers["mongodb-catchall"]) {
      if (usesTLS) {
        log("Updating catchall router for TLS passthrough", colors.blue);
        config.tcp.routers["mongodb-catchall"].tls = {
          passthrough: true,
        };
      } else {
        log("Removing TLS passthrough from catchall router", colors.blue);
        if (config.tcp.routers["mongodb-catchall"].tls) {
          delete config.tcp.routers["mongodb-catchall"].tls;
        }
      }
    }

    // Add or update the agent router
    log(`Adding/updating router for ${domain}`, colors.blue);
    config.tcp.routers[routerName] = {
      rule: `HostSNI(\`${domain}\`)`,
      entryPoints: ["mongodb"],
      service: serviceName,
    };

    // Add TLS passthrough if MongoDB uses TLS
    if (usesTLS) {
      config.tcp.routers[routerName].tls = {
        passthrough: true,
      };
    } else if (config.tcp.routers[routerName].tls) {
      delete config.tcp.routers[routerName].tls;
    }

    // Add the service
    log(`Adding service for ${TARGET_IP}:27017`, colors.blue);
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
    log(`Updated configuration at ${configPath}`, colors.green);

    // Restart Traefik
    log("Restarting Traefik...", colors.blue);
    try {
      execSync("docker restart traefik");
      log("Traefik restarted", colors.green);
    } catch (err) {
      log(`Failed to restart Traefik: ${err.message}`, colors.red);
      log("You may need to restart Traefik manually", colors.yellow);
    }

    log(
      `\nMongoDB connection should now be available at: ${domain}:27017`,
      colors.green
    );

    if (usesTLS) {
      log(
        `Try connecting with: mongosh "mongodb://admin:adminpassword@${domain}:27017/admin?ssl=true&authSource=admin&tlsAllowInvalidCertificates=true"`,
        colors.green
      );
    } else {
      log(
        `Try connecting with: mongosh "mongodb://admin:adminpassword@${domain}:27017/admin"`,
        colors.green
      );
    }
  } catch (err) {
    log(`Error: ${err.message}`, colors.red);
    process.exit(1);
  }
}

main();
