#!/usr/bin/env node
/**
 * MongoDB Connection Diagnostics Tool
 *
 * This script helps diagnose MongoDB connection issues by analyzing
 * connection strings and checking system configuration.
 *
 * Usage:
 *   node mongodb-debug.js [connection-string]
 *
 * Example:
 *   node mongodb-debug.js "mongodb://admin:password@agent-id.mongodb.cloudlunacy.uk:27017/admin?ssl=true"
 */

require("dotenv").config();
const { promisify } = require("util");
const exec = promisify(require("child_process").exec);
const fs = require("fs").promises;
const path = require("path");
const net = require("net");
const dns = require("dns").promises;

// Simple colored output without chalk
const chalk = {
  green: (text) => `\x1b[32m${text}\x1b[0m`,
  red: (text) => `\x1b[31m${text}\x1b[0m`,
  yellow: (text) => `\x1b[33m${text}\x1b[0m`,
  blue: (text) => `\x1b[34m${text}\x1b[0m`,
  bold: {
    white: (text) => `\x1b[1m\x1b[37m${text}\x1b[0m`,
  },
};

// Configuration
const CONFIG = {
  mongoDomain: process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk",
  configPath: process.env.CONFIG_PATH || "/opt/cloudlunacy_front/config",
  agentsConfigDir:
    process.env.AGENTS_CONFIG_DIR || "/opt/cloudlunacy_front/config/agents",
  dockerComposePath:
    process.env.DOCKER_COMPOSE_PATH ||
    "/opt/cloudlunacy_front/docker-compose.yml",
  dynamicConfigPath:
    process.env.DYNAMIC_CONFIG_PATH ||
    "/opt/cloudlunacy_front/config/dynamic.yml",
  mongoPort: 27017,
};

/**
 * Print success message
 */
function success(message) {
  console.log(chalk.green(message));
}

/**
 * Print warning message
 */
function warning(message) {
  console.log(chalk.yellow(message));
}

/**
 * Print error message
 */
function error(message) {
  console.log(chalk.red(message));
}

/**
 * Print info message
 */
function info(message) {
  console.log(chalk.blue(message));
}

/**
 * Print section header
 */
function section(title) {
  console.log(chalk.bold.white(`\n=== ${title} ===`));
}

/**
 * Parse MongoDB connection string
 */
function parseConnectionString(connectionString) {
  try {
    // Remove quotes if present
    const cleanString = connectionString.replace(/^["']|["']$/g, "");

    // Check if it starts with mongodb://
    if (!cleanString.startsWith("mongodb://")) {
      error("Invalid connection string format. Must start with 'mongodb://'");
      return null;
    }

    const parsedUrl = new URL(cleanString);
    success("Connection string format is valid");

    // Extract components from the URL
    const result = {
      username: parsedUrl.username,
      password: parsedUrl.password,
      host: parsedUrl.hostname,
      port: parsedUrl.port || "27017",
      database: parsedUrl.pathname.replace(/^\//, ""),
      params: Object.fromEntries(parsedUrl.searchParams),
    };

    // Extract agent ID if using the expected domain
    if (result.host.includes(CONFIG.mongoDomain)) {
      result.agentId = result.host.split(`.${CONFIG.mongoDomain}`)[0];
    }

    // Check SSL parameters
    if (result.params.ssl !== "true") {
      warning("SSL is not enabled in the connection string");
      info("For TLS connections, add 'ssl=true' to your connection string");
    }

    return result;
  } catch (err) {
    error(`Failed to parse connection string: ${err.message}`);
    return null;
  }
}

/**
 * Check DNS resolution for a hostname
 */
async function checkDnsResolution(hostname) {
  try {
    section("DNS Resolution Check");
    info(`Checking DNS resolution for ${hostname}...`);

    try {
      const addresses = await dns.resolve4(hostname);
      success(
        `DNS resolution successful: ${hostname} resolves to ${addresses.join(
          ", "
        )}`
      );
      return addresses;
    } catch (err) {
      error(`DNS resolution failed: ${err.message}`);

      // Try to ping the hostname as a fallback
      try {
        const { stdout } = await exec(`ping -c 1 ${hostname}`);
        if (stdout.includes("bytes from")) {
          const match = stdout.match(/\(([^)]+)\)/);
          if (match && match[1]) {
            warning(
              `Ping successful but DNS resolution failed. IP from ping: ${match[1]}`
            );
            return [match[1]];
          }
        }
      } catch (pingErr) {
        // Ping also failed
      }

      return null;
    }
  } catch (err) {
    error(`Error checking DNS resolution: ${err.message}`);
    return null;
  }
}

/**
 * Test direct TCP connection to a host and port
 */
async function testTcpConnection(host, port) {
  return new Promise((resolve) => {
    info(`Testing TCP connection to ${host}:${port}...`);

    const socket = net.createConnection({
      host,
      port: parseInt(port, 10),
    });

    socket.setTimeout(5000); // 5 second timeout

    socket.on("connect", () => {
      success(`TCP connection to ${host}:${port} successful`);
      socket.end();
      resolve(true);
    });

    socket.on("timeout", () => {
      error(`TCP connection to ${host}:${port} timed out`);
      socket.destroy();
      resolve(false);
    });

    socket.on("error", (err) => {
      error(`TCP connection to ${host}:${port} failed: ${err.message}`);
      resolve(false);
    });
  });
}

/**
 * Check if port 27017 is exposed in Traefik
 */
async function checkTraefikPortConfig() {
  try {
    section("Traefik Port Configuration");
    info("Checking if port 27017 is exposed in Traefik...");

    // Check docker ps output
    const { stdout: dockerPs } = await exec(
      'docker ps --format "{{.Names}} {{.Ports}}" | grep traefik'
    );

    if (dockerPs.includes(":27017->") || dockerPs.includes(":27017/")) {
      success("Port 27017 is correctly exposed in Traefik container");
      return true;
    } else {
      error("Port 27017 is NOT exposed in Traefik container");

      // Check docker-compose.yml
      try {
        const dockerCompose = await fs.readFile(
          CONFIG.dockerComposePath,
          "utf8"
        );

        if (
          dockerCompose.includes('"27017:27017"') ||
          dockerCompose.includes("'27017:27017'")
        ) {
          warning(
            "Port 27017 is defined in docker-compose.yml but not exposed in container"
          );
          info("You may need to restart the container: docker-compose up -d");
        } else {
          error("Port 27017 is not defined in docker-compose.yml");
          info(
            "Add '- \"27017:27017\"' to the ports section in docker-compose.yml and run docker-compose up -d"
          );
        }
      } catch (err) {
        error(`Could not read docker-compose.yml: ${err.message}`);
      }

      return false;
    }
  } catch (err) {
    warning(`Could not determine if port 27017 is exposed: ${err.message}`);
    return null;
  }
}

/**
 * Check if agent is registered
 */
async function checkAgentRegistration(agentId) {
  try {
    section("Agent Registration Check");
    info(`Checking registration for agent ${agentId}...`);

    const agentConfigPath = path.join(CONFIG.agentsConfigDir, `${agentId}.yml`);

    try {
      await fs.access(agentConfigPath);
      success(`Agent ${agentId} is registered with a configuration file`);

      // Read the config file to verify it has MongoDB routing
      const configContent = await fs.readFile(agentConfigPath, "utf8");

      if (
        configContent.includes("mongodb") &&
        configContent.includes("27017")
      ) {
        success(`Agent configuration contains MongoDB routing info`);
        return true;
      } else {
        warning(
          `Agent is registered but MongoDB routing may not be configured correctly`
        );
        return false;
      }
    } catch (err) {
      error(`Agent ${agentId} is not registered (no configuration file found)`);
      info(
        `Register the agent with: curl -X POST http://localhost:3005/api/agent/register -H "Content-Type: application/json" -d '{"agentId": "${agentId}"}'`
      );
      return false;
    }
  } catch (err) {
    error(`Error checking agent registration: ${err.message}`);
    return null;
  }
}

/**
 * Check MongoDB TLS routing in dynamic config
 */
async function checkDynamicConfig() {
  try {
    section("Traefik Dynamic Configuration");
    info("Checking Traefik dynamic configuration for MongoDB routing...");

    const configContent = await fs.readFile(CONFIG.dynamicConfigPath, "utf8");

    // Check for TCP routing and MongoDB configuration
    if (
      configContent.includes("tcp") &&
      configContent.includes("mongodb") &&
      configContent.includes("27017")
    ) {
      success("Traefik dynamic configuration contains MongoDB TCP routing");

      // Check for TLS passthrough
      if (configContent.includes("passthrough: true")) {
        success("TLS passthrough is correctly configured");
      } else {
        warning("TLS passthrough may not be correctly configured");
        info(
          "Ensure the MongoDB router in dynamic.yml has 'tls: { passthrough: true }'"
        );
      }

      return true;
    } else {
      error("Traefik dynamic configuration does not have MongoDB TCP routing");
      info(
        "Run the config validator: node /opt/cloudlunacy_front/node-app/scripts/startup-validator.js"
      );
      return false;
    }
  } catch (err) {
    error(`Could not read dynamic configuration: ${err.message}`);
    return null;
  }
}

/**
 * Get agent's IP address from configuration
 */
async function getAgentIp(agentId) {
  try {
    const agentConfigPath = path.join(CONFIG.agentsConfigDir, `${agentId}.yml`);
    const configContent = await fs.readFile(agentConfigPath, "utf8");

    // Extract IP address from the configuration
    const ipMatch = configContent.match(/address: ["']?([0-9.]+):27017["']?/);
    if (ipMatch && ipMatch[1]) {
      return ipMatch[1];
    }

    return null;
  } catch (err) {
    return null;
  }
}

/**
 * Add this function to test direct connection to the agent
 */
async function testDirectConnection(agentId) {
  try {
    // Get agent IP
    const agentIp = await getAgentIp(agentId);
    if (!agentIp) {
      error(`Could not find IP for agent ${agentId}`);
      return false;
    }

    info(`Testing direct connection to MongoDB at ${agentIp}:27017`);
    const connected = await testTcpConnection(agentIp, 27017);

    if (connected) {
      success(`Direct connection to MongoDB at ${agentIp}:27017 successful`);
    } else {
      error(`Direct connection to MongoDB at ${agentIp}:27017 failed`);
    }

    return connected;
  } catch (err) {
    error(`Error testing direct connection: ${err.message}`);
    return false;
  }
}

/**
 * Comprehensive MongoDB connection diagnostics
 */
async function diagnoseMongoDBConnection(connectionString) {
  console.log(chalk.bold("\nMongoDB Connection Diagnostics Tool"));
  console.log(chalk.bold("====================================="));

  // Step 1: Parse the connection string
  section("Connection String Analysis");
  console.log(`Connection string: ${connectionString}`);

  const parsed = parseConnectionString(connectionString);
  if (!parsed) {
    return;
  }

  console.log("\nConnection Parameters:");
  console.log(
    `• Username: ${parsed.username || chalk.yellow("Not specified")}`
  );
  console.log(
    `• Password: ${parsed.password ? "****" : chalk.yellow("Not specified")}`
  );
  console.log(`• Host: ${parsed.host}`);
  console.log(`• Port: ${parsed.port}`);
  console.log(
    `• Database: ${parsed.database || chalk.yellow("Not specified")}`
  );
  console.log(
    `• SSL Enabled: ${
      parsed.params.ssl === "true" ? chalk.green("Yes") : chalk.red("No")
    }`
  );
  console.log(
    `• TLS Allow Invalid Certificates: ${
      parsed.params.tlsAllowInvalidCertificates === "true"
        ? chalk.green("Yes")
        : chalk.red("No")
    }`
  );

  // Check for agent ID
  if (parsed.agentId) {
    success(`Hostname uses the correct domain pattern (${CONFIG.mongoDomain})`);
    info(`Detected Agent ID: ${parsed.agentId}`);
  } else {
    error(`Hostname does not use the expected domain pattern`);
    info(`Expected format: <agent-id>.${CONFIG.mongoDomain}`);
    // Cannot continue without agent ID
    return;
  }

  // Check SSL configuration
  section("SSL/TLS Configuration");
  if (parsed.params.ssl !== "true") {
    error(
      "SSL is not enabled. MongoDB connections through Traefik require SSL."
    );
    info("Add 'ssl=true' to your connection string.");
  } else {
    success("SSL is correctly enabled");
  }

  if (parsed.params.tlsAllowInvalidCertificates !== "true") {
    error(
      "tlsAllowInvalidCertificates is not enabled. This is required for self-signed certificates."
    );
    info("Add 'tlsAllowInvalidCertificates=true' to your connection string.");
  } else {
    success("tlsAllowInvalidCertificates is correctly enabled");
  }

  // Check DNS resolution
  const dnsAddresses = await checkDnsResolution(parsed.host);

  // Check Traefik configuration
  const traefikConfigured = await checkTraefikPortConfig();
  await checkDynamicConfig();

  // Check agent registration
  const agentRegistered = await checkAgentRegistration(parsed.agentId);

  // Test direct connection to Traefik
  section("Connection Tests");
  if (dnsAddresses && dnsAddresses.length > 0) {
    const frontServerIp = dnsAddresses[0];
    await testTcpConnection(frontServerIp, CONFIG.mongoPort);
  } else if (traefikConfigured) {
    // Try connecting to localhost if DNS failed but Traefik is configured
    await testTcpConnection("localhost", CONFIG.mongoPort);
  }

  // Test connection to the agent if we can find its IP
  if (agentRegistered) {
    const agentIp = await getAgentIp(parsed.agentId);
    if (agentIp) {
      info(`Found agent IP: ${agentIp}`);
      await testTcpConnection(agentIp, CONFIG.mongoPort);
    }
  }

  //  Final recommendations
  section("Recommendations");

  if (!parsed.params.ssl || !parsed.params.tlsAllowInvalidCertificates) {
    info(
      "Fix your connection string parameters (add ssl=true and tlsAllowInvalidCertificates=true)"
    );
  }

  if (!dnsAddresses) {
    info("Fix DNS resolution for the MongoDB domain");
  }

  if (!traefikConfigured) {
    info("Ensure Traefik is exposing port 27017");
  }

  if (!agentRegistered) {
    info(`Register agent ${parsed.agentId}`);
  }

  console.log("\nCorrected Connection String with TLS:");
  console.log(
    chalk.green(
      `mongodb://${parsed.username || "username"}:${
        parsed.password || "password"
      }@${parsed.agentId}.${CONFIG.mongoDomain}:${CONFIG.mongoPort}/${
        parsed.database || "admin"
      }?ssl=true&tlsAllowInvalidCertificates=true`
    )
  );
}

// Main execution
async function main() {
  // Get connection string from command line arguments
  const connectionString = process.argv[2];

  if (!connectionString) {
    console.log(chalk.yellow("\nNo connection string provided!"));
    console.log("Usage: node mongodb-debug.js [connection-string]");
    console.log("\nExample:");
    console.log(
      'node mongodb-debug.js "mongodb://admin:password@agent-id.mongodb.cloudlunacy.uk:27017/admin?ssl=true"'
    );
    return;
  }

  try {
    await diagnoseMongoDBConnection(connectionString);
  } catch (err) {
    console.error(chalk.red(`\nError during diagnostics: ${err.message}`));
    console.error(err.stack);
  }
}

// Run the main function if this script is executed directly
if (require.main === module) {
  main().catch((err) => {
    console.error(chalk.red(`Fatal error: ${err.message}`));
    process.exit(1);
  });
}

module.exports = {
  diagnoseMongoDBConnection,
  parseConnectionString,
  checkDnsResolution,
  testTcpConnection,
};
