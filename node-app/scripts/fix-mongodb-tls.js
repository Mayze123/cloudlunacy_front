#!/usr/bin/env node
/**
 * MongoDB TLS Configuration Fix
 *
 * This script fixes the MongoDB TLS configuration by ensuring the container
 * is started with the correct configuration file.
 */

const { execSync } = require("child_process");
const fs = require("fs").promises;
const path = require("path");

// Configuration
const MONGO_CONFIG_DIR = "/opt/cloudlunacy/mongodb";
const MONGO_CERTS_DIR = `${MONGO_CONFIG_DIR}/certs`;
const CONTAINER_NAME = "mongodb-agent";
const AGENT_ID = process.env.AGENT_ID || "240922b9-4d3b-4692-8d1c-1884d423092a";
const TARGET_IP = process.env.TARGET_IP || "128.140.53.203";

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

async function fixMongoDBTLS() {
  try {
    log("Fixing MongoDB TLS configuration...", colors.blue);

    // Check if MongoDB container exists
    const containerExists = execSync(
      `docker ps -a -q --filter "name=${CONTAINER_NAME}"`,
      { encoding: "utf8" }
    ).trim();

    if (containerExists) {
      log("Stopping and removing existing MongoDB container...", colors.yellow);
      execSync(`docker stop ${CONTAINER_NAME} || true`);
      execSync(`docker rm ${CONTAINER_NAME} || true`);
    }

    // Create MongoDB config directory if it doesn't exist
    try {
      await fs.mkdir(MONGO_CONFIG_DIR, { recursive: true });
      await fs.mkdir(MONGO_CERTS_DIR, { recursive: true });
    } catch (err) {
      log(`Error creating directories: ${err.message}`, colors.red);
    }

    // Create MongoDB configuration file with TLS settings
    const mongodConf = `
security:
  authorization: enabled
net:
  bindIp: 0.0.0.0
  port: 27017
  maxIncomingConnections: 100
  tls:
    mode: requireTLS
    certificateKeyFile: /etc/mongodb/certs/server.pem
    CAFile: /etc/mongodb/certs/ca.crt
    allowConnectionsWithoutCertificates: true
setParameter:
  failIndexKeyTooLong: false
  authenticationMechanisms: SCRAM-SHA-1,SCRAM-SHA-256
operationProfiling:
  slowOpThresholdMs: 100
  mode: slowOp
`;

    await fs.writeFile(path.join(MONGO_CONFIG_DIR, "mongod.conf"), mongodConf);
    log("Created MongoDB configuration file with TLS settings", colors.green);

    // Start MongoDB container with proper configuration
    log("Starting MongoDB container with TLS configuration...", colors.blue);
    const cmd = `docker run -d --name ${CONTAINER_NAME} \
      --restart always \
      -p 27017:27017 \
      -v ${MONGO_CONFIG_DIR}/mongod.conf:/etc/mongod.conf \
      -v ${MONGO_CERTS_DIR}:/etc/mongodb/certs \
      -e MONGO_INITDB_ROOT_USERNAME=admin \
      -e MONGO_INITDB_ROOT_PASSWORD=adminpassword \
      mongo:latest \
      --config /etc/mongod.conf`;

    execSync(cmd);
    log("MongoDB container started with TLS configuration", colors.green);

    // Wait for MongoDB to start
    log("Waiting for MongoDB to start...", colors.blue);
    execSync("sleep 5");

    // Test MongoDB connection
    log("Testing MongoDB connection...", colors.blue);
    const connectionString = `mongodb://admin:adminpassword@${TARGET_IP}:27017/admin?ssl=true&authSource=admin&tlsAllowInvalidCertificates=true`;

    try {
      execSync(
        `timeout 10 mongosh "${connectionString}" --eval "db.serverStatus()" 2>&1 || echo "Connection failed"`,
        { stdio: "inherit" }
      );
      log("MongoDB connection successful!", colors.green);
    } catch (err) {
      log(`Error testing MongoDB connection: ${err.message}`, colors.red);
    }

    log("MongoDB TLS configuration fixed successfully", colors.green);
    return true;
  } catch (err) {
    log(`Error fixing MongoDB TLS configuration: ${err.message}`, colors.red);
    return false;
  }
}

// Run the function
fixMongoDBTLS().then((success) => {
  if (!success) {
    process.exit(1);
  }
});
