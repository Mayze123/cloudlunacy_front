#!/usr/bin/env node
/**
 * Comprehensive MongoDB Connection Test
 *
 * This script performs a complete test of MongoDB connectivity through Traefik,
 * checking DNS, TCP, TLS, and MongoDB connections.
 */

const { execSync } = require("child_process");
const net = require("net");
const dns = require("dns").promises;
const fs = require("fs").promises;
const yaml = require("yaml");
const path = require("path");

// Configuration
const AGENT_ID = process.argv[2] || "240922b9-4d3b-4692-8d1c-1884d423092a";
const TARGET_IP = process.argv[3] || "128.140.53.203";
const MONGO_DOMAIN = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
const MONGO_PORT = 27017;

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
function success(message) {
  console.log(`${colors.green}✓ ${message}${colors.reset}`);
}

function error(message) {
  console.log(`${colors.red}✗ ${message}${colors.reset}`);
}

function info(message) {
  console.log(`${colors.blue}ℹ ${message}${colors.reset}`);
}

function warning(message) {
  console.log(`${colors.yellow}⚠ ${message}${colors.reset}`);
}

function header(message) {
  console.log(`\n${colors.bold}${message}${colors.reset}`);
}

// Execute command and return output
function execCommand(command) {
  try {
    return execSync(command, { encoding: "utf8" });
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

// Test functions
async function checkDNS(hostname) {
  header(`Checking DNS resolution for ${hostname}`);
  try {
    const addresses = await dns.resolve4(hostname);
    success(`DNS resolution successful: ${addresses.join(", ")}`);
    return addresses;
  } catch (err) {
    error(`DNS resolution failed: ${err.message}`);
    return null;
  }
}

async function testTcpConnection(host, port, description) {
  header(`Testing TCP connection to ${description || host}`);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(5000);

    socket.on("connect", () => {
      success(`TCP connection to ${host}:${port} successful`);
      socket.destroy();
      resolve(true);
    });

    socket.on("timeout", () => {
      error(`TCP connection to ${host}:${port} timed out`);
      socket.destroy();
      resolve(false);
    });

    socket.on("error", (err) => {
      error(`TCP connection to ${host}:${port} failed: ${err.message}`);
      socket.destroy();
      resolve(false);
    });

    info(`Attempting TCP connection to ${host}:${port}...`);
    socket.connect(port, host);
  });
}

async function checkTraefikConfig() {
  header("Checking Traefik Configuration");

  // Check if Traefik is running
  const traefikRunning = execCommand("docker ps | grep traefik").includes(
    "traefik"
  );
  if (!traefikRunning) {
    error("Traefik container is not running");
    return false;
  }

  success("Traefik container is running");

  // Check if port 27017 is exposed
  const portExposed = execCommand(
    "docker port traefik | grep 27017"
  ).toString();
  if (portExposed) {
    success(`MongoDB port is exposed: ${portExposed.trim()}`);
  } else {
    error("MongoDB port 27017 is not exposed in Traefik");
    return false;
  }

  // Try to find dynamic.yml
  const CONFIG_PATHS = [
    "/etc/traefik/dynamic.yml",
    "/app/config/dynamic.yml",
    "./config/dynamic.yml",
    "/opt/cloudlunacy_front/config/dynamic.yml",
  ];

  let configContent = null;

  for (const configPath of CONFIG_PATHS) {
    try {
      configContent = execCommand(`cat ${configPath} 2>/dev/null`);
      if (configContent && !configContent.startsWith("Error:")) {
        success(`Found dynamic.yml at ${configPath}`);
        break;
      }
    } catch (err) {
      // Continue to next path
    }
  }

  if (!configContent || configContent.startsWith("Error:")) {
    error("Could not find dynamic.yml configuration file");
    return false;
  }

  // Check for MongoDB configuration
  if (configContent.includes("mongodb-catchall")) {
    success("MongoDB catchall router is configured");
  } else {
    error("MongoDB catchall router is missing");
    return false;
  }

  if (configContent.includes("passthrough: true")) {
    success("TLS passthrough is configured");
  } else {
    error("TLS passthrough is not configured");
    return false;
  }

  // Check for specific agent router
  const agentRouterPattern = new RegExp(`mongodb-${AGENT_ID}`);
  if (agentRouterPattern.test(configContent)) {
    success(`Agent router for ${AGENT_ID} is configured`);
  } else {
    warning(`Agent router for ${AGENT_ID} is not configured`);
  }

  return true;
}

async function testDirectConnection(targetIp) {
  header(`Testing direct connection to MongoDB at ${targetIp}:27017`);

  // Test TCP connection
  const tcpResult = await testTcpConnection(targetIp, 27017, "MongoDB server");

  if (!tcpResult) {
    error("Cannot establish TCP connection to MongoDB server");
    return false;
  }

  // Try MongoDB connection
  info("Testing MongoDB connection...");
  const result = execCommand(
    `timeout 5 mongosh "mongodb://admin:adminpassword@${targetIp}:27017/admin" --eval "db.serverStatus()" 2>&1 || echo "Connection failed"`
  );

  if (result.includes("Connection failed")) {
    error("Direct MongoDB connection failed");

    // Try with TLS
    info("Testing MongoDB connection with TLS...");
    const tlsResult = execCommand(
      `timeout 5 mongosh "mongodb://admin:adminpassword@${targetIp}:27017/admin?ssl=true&tlsAllowInvalidCertificates=true" --eval "db.serverStatus()" 2>&1 || echo "Connection failed"`
    );

    if (tlsResult.includes("Connection failed")) {
      error("Direct MongoDB connection with TLS also failed");
      return false;
    } else {
      success("Direct MongoDB connection with TLS succeeded");
      return true;
    }
  } else {
    success("Direct MongoDB connection succeeded");
    return true;
  }
}

async function testTraefikConnection() {
  header("Testing MongoDB connection through Traefik");

  const hostname = `${AGENT_ID}.${MONGO_DOMAIN}`;
  const connectionString = `mongodb://admin:adminpassword@${hostname}:${MONGO_PORT}/admin?ssl=true&authSource=admin&tlsAllowInvalidCertificates=true`;

  info(`Connection string: ${connectionString}`);

  const result = execCommand(
    `timeout 10 mongosh "${connectionString}" --eval "db.serverStatus()" 2>&1 || echo "Connection failed"`
  );

  if (result.includes("Connection failed")) {
    error("MongoDB connection through Traefik failed");

    // Try without TLS
    info("Testing MongoDB connection without TLS...");
    const noTlsResult = execCommand(
      `timeout 10 mongosh "mongodb://admin:adminpassword@${hostname}:${MONGO_PORT}/admin" --eval "db.serverStatus()" 2>&1 || echo "Connection failed"`
    );

    if (noTlsResult.includes("Connection failed")) {
      error("MongoDB connection without TLS also failed");
      return false;
    } else {
      success("MongoDB connection without TLS succeeded");
      warning(
        "Your MongoDB server is not using TLS, but Traefik is configured for TLS passthrough"
      );
      info(
        "Consider updating your Traefik configuration to match your MongoDB setup"
      );
      return true;
    }
  } else {
    success("MongoDB connection through Traefik succeeded");
    return true;
  }
}

// Main function
async function main() {
  console.log(
    `${colors.bold}Comprehensive MongoDB Connection Test${colors.reset}`
  );
  console.log("===========================================");

  const hostname = `${AGENT_ID}.${MONGO_DOMAIN}`;
  info(`Testing connection to: ${hostname}:${MONGO_PORT}`);

  // Step 1: Check DNS resolution
  const addresses = await checkDNS(hostname);

  // Step 2: Check Traefik configuration
  const traefikConfigOk = await checkTraefikConfig();

  // Step 3: Test TCP connection to Traefik
  if (addresses && addresses.length > 0) {
    await testTcpConnection(addresses[0], MONGO_PORT, hostname);
  } else {
    warning("DNS resolution failed, trying localhost");
    await testTcpConnection("localhost", MONGO_PORT, "Traefik on localhost");
  }

  // Step 4: Test direct connection to MongoDB server
  const directConnectionOk = await testDirectConnection(TARGET_IP);

  // Step 5: Test MongoDB connection through Traefik
  const traefikConnectionOk = await testTraefikConnection();

  // Summary
  header("Summary");

  if (addresses) {
    success("DNS resolution: OK");
  } else {
    error("DNS resolution: FAILED");
  }

  if (traefikConfigOk) {
    success("Traefik configuration: OK");
  } else {
    error("Traefik configuration: ISSUES FOUND");
  }

  if (directConnectionOk) {
    success("Direct MongoDB connection: OK");
  } else {
    error("Direct MongoDB connection: FAILED");
  }

  if (traefikConnectionOk) {
    success("MongoDB connection through Traefik: OK");
  } else {
    error("MongoDB connection through Traefik: FAILED");
  }

  // Recommendations
  header("Recommendations");

  if (!addresses) {
    info("1. Fix DNS resolution for your MongoDB domain");
  }

  if (!traefikConfigOk) {
    info("2. Fix Traefik configuration for MongoDB routing");
    info("   Run: node scripts/fix-mongodb-connection.js");
  }

  if (!directConnectionOk) {
    info("3. Check if MongoDB is running correctly on the target server");
    info(`   Verify you can connect directly to ${TARGET_IP}:27017`);
  }

  if (!traefikConnectionOk) {
    info("4. Check if MongoDB requires TLS or not");
    info("   Update Traefik configuration to match your MongoDB setup");
  }

  if (directConnectionOk && !traefikConnectionOk) {
    info("5. The issue is likely in the Traefik configuration");
    info("   Run: node scripts/fix-mongodb-connection.js");
  }
}

main().catch((err) => {
  console.error(`${colors.red}Fatal error: ${err.message}${colors.reset}`);
  process.exit(1);
});
