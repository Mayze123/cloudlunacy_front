#!/usr/bin/env node
/**
 * MongoDB Connection Tester
 *
 * This script tests MongoDB connections through Traefik
 */

const net = require("net");
const { execSync } = require("child_process");

// Get agent ID from command line
const agentId = process.argv[2];
if (!agentId) {
  console.error("Please provide an agent ID");
  console.error("Usage: node test-mongo-connection.js <agent-id>");
  process.exit(1);
}

// Configuration
const MONGO_DOMAIN = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
const MONGO_PORT = 27017;
const hostname = `${agentId}.${MONGO_DOMAIN}`;

console.log(`Testing MongoDB connection to ${hostname}:${MONGO_PORT}`);

// Test TCP connection
function testTcpConnection() {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(5000);

    socket.on("connect", () => {
      console.log(`Successfully connected to ${hostname}:${MONGO_PORT}`);
      socket.destroy();
      resolve(true);
    });

    socket.on("timeout", () => {
      console.error(`Connection to ${hostname}:${MONGO_PORT} timed out`);
      socket.destroy();
      resolve(false);
    });

    socket.on("error", (err) => {
      console.error(`Connection error: ${err.message}`);
      socket.destroy();
      resolve(false);
    });

    console.log(`Attempting to connect to ${hostname}:${MONGO_PORT}...`);
    socket.connect(MONGO_PORT, hostname);
  });
}

// Test MongoDB connection
async function testMongoConnection() {
  const connectionString = `mongodb://admin:adminpassword@${hostname}:${MONGO_PORT}/admin?ssl=true&authSource=admin&tlsAllowInvalidCertificates=true`;

  console.log(`Connection string: ${connectionString}`);

  try {
    // Use a timeout to prevent hanging
    execSync(
      `timeout 10 mongosh "${connectionString}" --eval "db.serverStatus()" 2>&1 || echo "Connection failed"`,
      { stdio: "inherit" }
    );
    return true;
  } catch (err) {
    console.error(`Error testing MongoDB connection: ${err.message}`);
    return false;
  }
}

// Main function
async function main() {
  // Test TCP connection
  const tcpResult = await testTcpConnection();

  if (tcpResult) {
    console.log("TCP connection successful, testing MongoDB connection...");
    await testMongoConnection();
  } else {
    console.log("TCP connection failed, checking Traefik configuration...");

    try {
      // Check if Traefik is exposing port 27017
      const portExposed = execSync(
        "docker port traefik | grep 27017"
      ).toString();
      console.log(`MongoDB port exposure: ${portExposed.trim()}`);

      // Check if the agent's router is configured
      const dynamicConfig = execSync(
        "cat /etc/traefik/dynamic.yml || cat /app/config/dynamic.yml || cat config/dynamic.yml 2>/dev/null"
      ).toString();

      if (dynamicConfig.includes(`${agentId}.${MONGO_DOMAIN}`)) {
        console.log(`Agent router for ${agentId} is configured`);
      } else {
        console.error(`No router configuration found for ${agentId}`);
      }
    } catch (err) {
      console.error(`Error checking configuration: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
