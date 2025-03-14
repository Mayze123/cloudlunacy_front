#!/usr/bin/env node
/**
 * MongoDB Connection Debugger
 *
 * This script helps diagnose issues with MongoDB connections through Traefik
 */

const { execSync } = require("child_process");
const net = require("net");
const dns = require("dns").promises;

// Configuration
const AGENT_ID = process.argv[2] || "240922b9-4d3b-4692-8d1c-1884d423092a";
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

async function testTcpConnection(host, port) {
  header(`Testing TCP connection to ${host}:${port}`);
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(5000);

    socket.on("connect", () => {
      success(`Successfully connected to ${host}:${port}`);
      socket.destroy();
      resolve(true);
    });

    socket.on("timeout", () => {
      error(`Connection to ${host}:${port} timed out`);
      socket.destroy();
      resolve(false);
    });

    socket.on("error", (err) => {
      error(`Connection error: ${err.message}`);
      socket.destroy();
      resolve(false);
    });

    info(`Attempting to connect to ${host}:${port}...`);
    socket.connect(port, host);
  });
}

function checkTraefikConfig() {
  header("Checking Traefik configuration");
  try {
    // Check if Traefik is running
    const traefikStatus = execSync("docker ps | grep traefik").toString();
    success("Traefik container is running");

    // Check if port 27017 is exposed
    const portExposed = execSync("docker port traefik | grep 27017").toString();
    if (portExposed) {
      success(`MongoDB port is exposed: ${portExposed.trim()}`);
    } else {
      error("MongoDB port 27017 is not exposed in Traefik");
    }

    // Check dynamic configuration
    const dynamicConfig = execSync(
      "cat /etc/traefik/dynamic.yml || cat /app/config/dynamic.yml || cat config/dynamic.yml"
    ).toString();

    if (dynamicConfig.includes("mongodb-catchall")) {
      success("MongoDB catchall router is configured");
    } else {
      error("MongoDB catchall router is not configured");
    }

    if (dynamicConfig.includes(`${AGENT_ID}.mongodb`)) {
      success(`Agent-specific MongoDB router for ${AGENT_ID} is configured`);
    } else {
      warning(`No agent-specific MongoDB router found for ${AGENT_ID}`);
    }

    if (dynamicConfig.includes("passthrough: true")) {
      success("TLS passthrough is configured");
    } else {
      error("TLS passthrough is not configured properly");
    }

    return true;
  } catch (err) {
    error(`Error checking Traefik configuration: ${err.message}`);
    return false;
  }
}

function testMongoConnection() {
  header("Testing MongoDB connection with mongosh");
  const hostname = `${AGENT_ID}.${MONGO_DOMAIN}`;
  const connectionString = `mongodb://admin:adminpassword@${hostname}:${MONGO_PORT}/admin?ssl=true&authSource=admin&tlsAllowInvalidCertificates=true`;

  info(`Connection string: ${connectionString}`);

  try {
    // Use a timeout to prevent hanging
    execSync(
      `timeout 10 mongosh "${connectionString}" --eval "db.serverStatus()" 2>&1 || echo "Connection failed"`,
      { stdio: "inherit" }
    );
    return true;
  } catch (err) {
    error(`Error testing MongoDB connection: ${err.message}`);
    return false;
  }
}

// Main function
async function main() {
  console.log(`${colors.bold}MongoDB Connection Debugger${colors.reset}`);
  console.log("=========================");

  const hostname = `${AGENT_ID}.${MONGO_DOMAIN}`;
  info(`Testing connection to: ${hostname}:${MONGO_PORT}`);

  // Step 1: Check DNS resolution
  const addresses = await checkDNS(hostname);

  // Step 2: Check Traefik configuration
  checkTraefikConfig();

  // Step 3: Test TCP connection
  if (addresses && addresses.length > 0) {
    await testTcpConnection(addresses[0], MONGO_PORT);
  }

  // Step 4: Test direct connection to Traefik
  await testTcpConnection("localhost", MONGO_PORT);

  // Step 5: Test MongoDB connection
  testMongoConnection();

  // Summary
  header("Recommendations");
  info(
    "1. Ensure TLS passthrough is properly configured in all MongoDB routers"
  );
  info(
    "2. Check that the target MongoDB server is actually running on port 27017"
  );
  info("3. Verify that Traefik is correctly exposing port 27017");
  info(
    "4. Try connecting directly to the MongoDB server to verify it's accessible"
  );
}

main().catch((err) => {
  console.error(`${colors.red}Fatal error: ${err.message}${colors.reset}`);
  process.exit(1);
});
