#!/usr/bin/env node
/**
 * Fix MongoDB Connection Issues
 *
 * This script diagnoses and fixes common MongoDB connection issues through Traefik
 */

const { execSync } = require("child_process");
const fs = require("fs").promises;
const yaml = require("yaml");
const path = require("path");
const net = require("net");
const dns = require("dns").promises;

// Configuration
const AGENT_ID = process.argv[2] || "240922b9-4d3b-4692-8d1c-1884d423092a";
const TARGET_IP = process.argv[3] || "128.140.53.203";
const MONGO_DOMAIN = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
const MONGO_PORT = 27017;
const TRAEFIK_CONTAINER = process.env.TRAEFIK_CONTAINER || "traefik";
const DYNAMIC_CONFIG_PATH =
  process.env.DYNAMIC_CONFIG_PATH || "/etc/traefik/dynamic.yml";
const LOCAL_CONFIG_PATH = "./config/dynamic.yml";

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
  log(`\n${colors.bold}${message}${colors.reset}`);
}

// Fix functions
async function fixMongoDBPort() {
  header("Checking MongoDB port exposure");

  try {
    const portCheck = execSync(
      `docker port ${TRAEFIK_CONTAINER} | grep 27017`,
      { encoding: "utf8" }
    );
    if (portCheck) {
      success(`MongoDB port is already exposed: ${portCheck.trim()}`);
      return true;
    }
  } catch (err) {
    error("MongoDB port 27017 is not exposed in Traefik");
  }

  info("Attempting to fix MongoDB port exposure...");

  // Try restarting Traefik first
  try {
    info("Restarting Traefik container...");
    execSync(`docker restart ${TRAEFIK_CONTAINER}`, { encoding: "utf8" });

    // Check if port is now exposed
    try {
      const portCheck = execSync(
        `docker port ${TRAEFIK_CONTAINER} | grep 27017`,
        { encoding: "utf8" }
      );
      if (portCheck) {
        success(
          `MongoDB port is now exposed after restart: ${portCheck.trim()}`
        );
        return true;
      }
    } catch (err) {
      warning("MongoDB port is still not exposed after restart");
    }
  } catch (err) {
    error(`Failed to restart Traefik: ${err.message}`);
  }

  // If restart didn't work, check docker-compose.yml
  info("Checking docker-compose.yml configuration...");

  const composeFiles = [
    "/opt/cloudlunacy_front/docker-compose.yml",
    "./docker-compose.yml",
    "../docker-compose.yml",
  ];

  let composeFile = null;
  let composeContent = null;

  for (const file of composeFiles) {
    try {
      composeContent = await fs.readFile(file, "utf8");
      composeFile = file;
      info(`Found docker-compose.yml at ${file}`);
      break;
    } catch (err) {
      // Continue to next file
    }
  }

  if (!composeFile) {
    error("Could not find docker-compose.yml");
    return false;
  }

  // Parse and modify docker-compose.yml
  try {
    const compose = yaml.parse(composeContent);

    if (
      compose.services &&
      compose.services.traefik &&
      compose.services.traefik.ports
    ) {
      const ports = compose.services.traefik.ports;
      const hasMongoPort = ports.some((port) => port.includes("27017:27017"));

      if (!hasMongoPort) {
        info("Adding MongoDB port 27017 to docker-compose.yml");
        ports.push("27017:27017");

        // Create backup
        await fs.writeFile(`${composeFile}.bak`, composeContent);
        info(`Created backup at ${composeFile}.bak`);

        // Write updated file
        const updatedContent = yaml.stringify(compose);
        await fs.writeFile(composeFile, updatedContent);
        success(`Updated ${composeFile}`);

        // Apply changes
        info("Restarting Traefik to apply changes...");
        execSync(`docker restart ${TRAEFIK_CONTAINER}`, { encoding: "utf8" });

        // Verify port is now exposed
        try {
          const portCheck = execSync(
            `docker port ${TRAEFIK_CONTAINER} | grep 27017`,
            { encoding: "utf8" }
          );
          if (portCheck) {
            success(`MongoDB port is now exposed: ${portCheck.trim()}`);
            return true;
          } else {
            error(
              "MongoDB port is still not exposed after configuration update"
            );
            return false;
          }
        } catch (err) {
          error("MongoDB port is still not exposed after configuration update");
          return false;
        }
      } else {
        info("MongoDB port 27017 is already configured in docker-compose.yml");
        warning(
          "Port is configured but not exposed. This might be a Docker issue."
        );
        return false;
      }
    } else {
      error("Could not find Traefik service in docker-compose.yml");
      return false;
    }
  } catch (err) {
    error(`Failed to parse or update docker-compose.yml: ${err.message}`);
    return false;
  }
}

async function fixTraefikConfig() {
  header("Checking Traefik configuration");

  // Find dynamic.yml
  const configPaths = [DYNAMIC_CONFIG_PATH, LOCAL_CONFIG_PATH];
  let configPath = null;
  let configContent = null;

  for (const path of configPaths) {
    try {
      configContent = await fs.readFile(path, "utf8");
      configPath = path;
      info(`Found dynamic.yml at ${path}`);
      break;
    } catch (err) {
      // Continue to next path
    }
  }

  if (!configPath) {
    error("Could not find dynamic.yml");
    return false;
  }

  // Parse and check configuration
  try {
    const config = yaml.parse(configContent);
    let modified = false;

    // Ensure TCP section exists
    if (!config.tcp) {
      info("Adding TCP section to configuration");
      config.tcp = { routers: {}, services: {} };
      modified = true;
    }

    // Check for MongoDB catchall router
    if (!config.tcp.routers["mongodb-catchall"]) {
      info("Adding MongoDB catchall router");
      config.tcp.routers["mongodb-catchall"] = {
        rule: `HostSNI(\`*.${MONGO_DOMAIN}\`)`,
        entryPoints: ["mongodb"],
        service: "mongodb-catchall-service",
        tls: {
          passthrough: true,
        },
      };
      modified = true;
    }

    // Check for MongoDB catchall service
    if (!config.tcp.services["mongodb-catchall-service"]) {
      info("Adding MongoDB catchall service");
      config.tcp.services["mongodb-catchall-service"] = {
        loadBalancer: {
          servers: [],
        },
      };
      modified = true;
    }

    // Check for agent-specific router
    const routerName = `mongodb-${AGENT_ID}`;
    const serviceName = `${routerName}-service`;

    if (!config.tcp.routers[routerName]) {
      info(`Adding router for agent ${AGENT_ID}`);
      config.tcp.routers[routerName] = {
        rule: `HostSNI(\`${AGENT_ID}.${MONGO_DOMAIN}\`)`,
        entryPoints: ["mongodb"],
        service: serviceName,
        tls: {
          passthrough: true,
        },
      };
      modified = true;
    }

    // Check for agent-specific service
    if (!config.tcp.services[serviceName]) {
      info(`Adding service for agent ${AGENT_ID}`);
      config.tcp.services[serviceName] = {
        loadBalancer: {
          servers: [
            {
              address: `${TARGET_IP}:${MONGO_PORT}`,
            },
          ],
        },
      };
      modified = true;
    } else {
      // Check if the target IP is correct
      const servers = config.tcp.services[serviceName].loadBalancer.servers;
      if (!servers || servers.length === 0) {
        info(`Adding target server ${TARGET_IP}:${MONGO_PORT} to service`);
        config.tcp.services[serviceName].loadBalancer.servers = [
          {
            address: `${TARGET_IP}:${MONGO_PORT}`,
          },
        ];
        modified = true;
      } else {
        const hasCorrectServer = servers.some(
          (server) => server.address === `${TARGET_IP}:${MONGO_PORT}`
        );

        if (!hasCorrectServer) {
          info(`Updating target server to ${TARGET_IP}:${MONGO_PORT}`);
          servers[0].address = `${TARGET_IP}:${MONGO_PORT}`;
          modified = true;
        }
      }
    }

    // Save changes if modified
    if (modified) {
      // Create backup
      await fs.writeFile(`${configPath}.bak`, configContent);
      info(`Created backup at ${configPath}.bak`);

      // Write updated file
      const updatedContent = yaml.stringify(config);
      await fs.writeFile(configPath, updatedContent);
      success(`Updated ${configPath}`);

      // Restart Traefik to apply changes
      info("Restarting Traefik to apply changes...");
      execSync(`docker restart ${TRAEFIK_CONTAINER}`, { encoding: "utf8" });
      success("Traefik restarted");

      return true;
    } else {
      success("Traefik configuration is already correct");
      return true;
    }
  } catch (err) {
    error(`Failed to parse or update dynamic.yml: ${err.message}`);
    return false;
  }
}

async function testConnection() {
  header("Testing MongoDB connection");

  const hostname = `${AGENT_ID}.${MONGO_DOMAIN}`;
  info(`Testing connection to ${hostname}:${MONGO_PORT}`);

  // Test TCP connection first
  const socket = new net.Socket();

  try {
    await new Promise((resolve, reject) => {
      socket.setTimeout(5000);

      socket.on("connect", () => {
        success(`TCP connection to ${hostname}:${MONGO_PORT} successful`);
        socket.destroy();
        resolve();
      });

      socket.on("timeout", () => {
        error(`TCP connection to ${hostname}:${MONGO_PORT} timed out`);
        socket.destroy();
        reject(new Error("Connection timed out"));
      });

      socket.on("error", (err) => {
        error(`TCP connection error: ${err.message}`);
        socket.destroy();
        reject(err);
      });

      info(`Attempting to connect to ${hostname}:${MONGO_PORT}...`);
      socket.connect(MONGO_PORT, hostname);
    });
  } catch (err) {
    warning("TCP connection failed, trying localhost...");

    try {
      await new Promise((resolve, reject) => {
        const localSocket = new net.Socket();
        localSocket.setTimeout(5000);

        localSocket.on("connect", () => {
          success(`TCP connection to localhost:${MONGO_PORT} successful`);
          localSocket.destroy();
          resolve();
        });

        localSocket.on("timeout", () => {
          error(`TCP connection to localhost:${MONGO_PORT} timed out`);
          localSocket.destroy();
          reject(new Error("Connection timed out"));
        });

        localSocket.on("error", (err) => {
          error(`TCP connection error: ${err.message}`);
          localSocket.destroy();
          reject(err);
        });

        info(`Attempting to connect to localhost:${MONGO_PORT}...`);
        localSocket.connect(MONGO_PORT, "localhost");
      });
    } catch (localErr) {
      error("Both hostname and localhost connections failed");
    }
  }

  // Test MongoDB connection
  info("Testing MongoDB connection with mongosh...");

  // Test with TLS
  try {
    const tlsCommand = `timeout 10 mongosh "mongodb://admin:adminpassword@${hostname}:${MONGO_PORT}/admin?ssl=true&tlsAllowInvalidCertificates=true" --eval "db.serverStatus()" 2>&1 || echo "Connection failed"`;
    const tlsResult = execSync(tlsCommand, { encoding: "utf8" });

    if (tlsResult.includes("Connection failed")) {
      warning("MongoDB connection with TLS failed, trying without TLS...");

      // Try without TLS
      const noTlsCommand = `timeout 10 mongosh "mongodb://admin:adminpassword@${hostname}:${MONGO_PORT}/admin" --eval "db.serverStatus()" 2>&1 || echo "Connection failed"`;
      const noTlsResult = execSync(noTlsCommand, { encoding: "utf8" });

      if (noTlsResult.includes("Connection failed")) {
        error("MongoDB connection without TLS also failed");

        // Try direct connection to target
        info(`Testing direct connection to ${TARGET_IP}:${MONGO_PORT}...`);
        const directCommand = `timeout 10 mongosh "mongodb://admin:adminpassword@${TARGET_IP}:${MONGO_PORT}/admin?ssl=true&tlsAllowInvalidCertificates=true" --eval "db.serverStatus()" 2>&1 || echo "Connection failed"`;
        const directResult = execSync(directCommand, { encoding: "utf8" });

        if (directResult.includes("Connection failed")) {
          error(`Direct connection to ${TARGET_IP}:${MONGO_PORT} failed`);
          warning(
            "The MongoDB server might not be running or has different credentials"
          );
        } else {
          success(`Direct connection to ${TARGET_IP}:${MONGO_PORT} succeeded`);
          warning(
            "The issue is with Traefik routing, not the MongoDB server itself"
          );
        }
      } else {
        success("MongoDB connection without TLS succeeded");
        warning(
          "Your MongoDB server is not using TLS, but Traefik is configured for TLS passthrough"
        );
        warning("This mismatch might cause connection issues");
      }
    } else {
      success("MongoDB connection with TLS succeeded");
    }
  } catch (err) {
    error(`Error testing MongoDB connection: ${err.message}`);
  }
}

// Main function
async function main() {
  console.log(`${colors.bold}MongoDB Connection Fixer${colors.reset}`);
  console.log("=========================");

  // Step 1: Fix MongoDB port exposure
  const portFixed = await fixMongoDBPort();

  // Step 2: Fix Traefik configuration
  const configFixed = await fixTraefikConfig();

  // Step 3: Test connection
  await testConnection();

  // Summary
  header("Summary");

  if (portFixed) {
    success("MongoDB port exposure: FIXED");
  } else {
    warning("MongoDB port exposure: ISSUES REMAIN");
  }

  if (configFixed) {
    success("Traefik configuration: FIXED");
  } else {
    warning("Traefik configuration: ISSUES REMAIN");
  }

  // Final recommendations
  header("Final Recommendations");

  info("1. If connection issues persist, check the following:");
  info("   - DNS resolution for your MongoDB domain");
  info("   - Firewall rules on both Traefik and MongoDB servers");
  info("   - MongoDB authentication settings");
  info("   - TLS configuration on MongoDB server");

  info("\n2. Run the test script to verify the connection:");
  info("   node scripts/test-mongodb-connection.js");

  info("\n3. Check Traefik logs for more details:");
  info("   docker logs traefik | grep -i mongodb");
}

main().catch((err) => {
  console.error(`${colors.red}Fatal error: ${err.message}${colors.reset}`);
  process.exit(1);
});
