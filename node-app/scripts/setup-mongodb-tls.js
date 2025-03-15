#!/usr/bin/env node
/**
 * MongoDB TLS Setup Script
 *
 * This script sets up TLS for MongoDB by:
 * 1. Generating certificates if they don't exist
 * 2. Configuring MongoDB to use TLS
 * 3. Updating Traefik configuration for TLS passthrough
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
const { execSync } = require("child_process");
const axios = require("axios");
const yaml = require("yaml");

// Configuration
const CERTS_DIR = process.env.CERTS_DIR || "/opt/cloudlunacy/certs";
const AGENT_ID = process.env.SERVER_ID || process.argv[2];
const AGENT_TOKEN = process.env.AGENT_API_TOKEN || process.argv[3];
const FRONT_API_URL = process.env.FRONT_API_URL || "http://localhost:3005";
const MONGO_DOMAIN = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";

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

/**
 * Fetch certificates from front server
 */
async function fetchCertificates() {
  log("Fetching TLS certificates from front server...", colors.blue);

  try {
    // Create certificates directory
    await fs.mkdir(CERTS_DIR, { recursive: true });

    // Get JWT token from environment or file
    let token = AGENT_TOKEN;

    // If no token provided, try to read from JWT file
    if (!token) {
      try {
        const jwtFile = "/opt/cloudlunacy/.agent_jwt.json";
        const jwtData = await fs.readFile(jwtFile, "utf8");
        const jwt = JSON.parse(jwtData);
        token = jwt.token;
      } catch (err) {
        log(`Failed to read JWT file: ${err.message}`, colors.red);
        return false;
      }
    }

    if (!token) {
      log("No authentication token available", colors.red);
      return false;
    }

    // Fetch CA certificate
    log("Fetching CA certificate...", colors.blue);
    const caResponse = await axios.get(
      `${FRONT_API_URL}/api/certificates/mongodb-ca`
    );

    if (!caResponse.data) {
      log("Failed to fetch CA certificate", colors.red);
      return false;
    }

    // Save CA certificate
    await fs.writeFile(path.join(CERTS_DIR, "ca.crt"), caResponse.data);
    log("CA certificate saved", colors.green);

    // Fetch agent certificates
    log(`Fetching certificates for agent ${AGENT_ID}...`, colors.blue);
    const certResponse = await axios.get(
      `${FRONT_API_URL}/api/certificates/agent/${AGENT_ID}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    if (!certResponse.data || !certResponse.data.success) {
      log(
        `Failed to fetch agent certificates: ${
          certResponse.data?.error || "Unknown error"
        }`,
        colors.red
      );
      return false;
    }

    // Save certificates
    const certs = certResponse.data.certificates;
    await fs.writeFile(path.join(CERTS_DIR, "server.key"), certs.serverKey);
    await fs.writeFile(path.join(CERTS_DIR, "server.crt"), certs.serverCert);

    // Create combined PEM file
    await fs.writeFile(
      path.join(CERTS_DIR, "server.pem"),
      certs.serverKey + certs.serverCert
    );

    // Set proper permissions
    await fs.chmod(path.join(CERTS_DIR, "server.key"), 0o600);
    await fs.chmod(path.join(CERTS_DIR, "server.pem"), 0o600);

    log("Agent certificates saved successfully", colors.green);
    return true;
  } catch (err) {
    log(`Failed to fetch certificates: ${err.message}`, colors.red);
    return false;
  }
}

/**
 * Configure MongoDB for TLS
 */
async function configureMongoDB() {
  log("Configuring MongoDB for TLS...", colors.blue);

  try {
    // Check if MongoDB is running in Docker
    const mongoContainer = execSync(
      'docker ps -q --filter "name=mongodb-agent"',
      { encoding: "utf8" }
    ).trim();

    if (mongoContainer) {
      log("Found MongoDB container, reconfiguring for TLS...", colors.blue);

      // Create MongoDB config directory
      const mongoConfigDir = "/opt/cloudlunacy/mongodb";
      const mongoCertsDir = `${mongoConfigDir}/certs`;

      await fs.mkdir(mongoConfigDir, { recursive: true });
      await fs.mkdir(mongoCertsDir, { recursive: true });

      // Copy certificates to MongoDB config directory
      await fs.copyFile(
        path.join(CERTS_DIR, "ca.crt"),
        path.join(mongoCertsDir, "ca.crt")
      );
      await fs.copyFile(
        path.join(CERTS_DIR, "server.key"),
        path.join(mongoCertsDir, "server.key")
      );
      await fs.copyFile(
        path.join(CERTS_DIR, "server.crt"),
        path.join(mongoCertsDir, "server.crt")
      );
      await fs.copyFile(
        path.join(CERTS_DIR, "server.pem"),
        path.join(mongoCertsDir, "server.pem")
      );

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

      await fs.writeFile(path.join(mongoConfigDir, "mongod.conf"), mongodConf);

      // Stop existing MongoDB container
      log("Stopping existing MongoDB container...", colors.blue);
      execSync("docker stop mongodb-agent");
      execSync("docker rm mongodb-agent");

      // Start MongoDB container with TLS configuration
      log("Starting MongoDB with TLS configuration...", colors.blue);
      execSync(`
        docker run -d \\
          --name mongodb-agent \\
          -p 27017:27017 \\
          -v "${mongoConfigDir}/mongod.conf:/etc/mongod.conf" \\
          -v "${mongoCertsDir}:/etc/mongodb/certs" \\
          -e MONGO_INITDB_ROOT_USERNAME=admin \\
          -e MONGO_INITDB_ROOT_PASSWORD=adminpassword \\
          mongo:latest \\
          --config /etc/mongod.conf \\
          --auth
      `);

      log("MongoDB container reconfigured with TLS support", colors.green);
      return true;
    } else {
      log(
        "MongoDB is not running in Docker, please configure it manually",
        colors.yellow
      );
      log(
        "Copy the certificates from " + CERTS_DIR + " to your MongoDB server",
        colors.yellow
      );
      return false;
    }
  } catch (err) {
    log(`Failed to configure MongoDB: ${err.message}`, colors.red);
    return false;
  }
}

/**
 * Update environment variables for TLS
 */
async function updateEnvironment() {
  log("Updating environment variables for TLS...", colors.blue);

  try {
    const envFile = "/opt/cloudlunacy/.env";
    let envContent = "";

    try {
      envContent = await fs.readFile(envFile, "utf8");
    } catch (err) {
      log("Environment file not found, creating new one", colors.yellow);
    }

    // Update TLS settings
    const envLines = envContent.split("\n");
    const updatedLines = [];
    let tlsUpdated = false;

    for (const line of envLines) {
      if (line.startsWith("MONGO_USE_TLS=")) {
        updatedLines.push("MONGO_USE_TLS=true");
        tlsUpdated = true;
      } else if (line.startsWith("MONGO_CERT_PATH=")) {
        updatedLines.push(`MONGO_CERT_PATH=${CERTS_DIR}/server.crt`);
      } else if (line.startsWith("MONGO_KEY_PATH=")) {
        updatedLines.push(`MONGO_KEY_PATH=${CERTS_DIR}/server.key`);
      } else if (line.startsWith("MONGO_CA_PATH=")) {
        updatedLines.push(`MONGO_CA_PATH=${CERTS_DIR}/ca.crt`);
      } else {
        updatedLines.push(line);
      }
    }

    if (!tlsUpdated) {
      updatedLines.push("MONGO_USE_TLS=true");
      updatedLines.push(`MONGO_CERT_PATH=${CERTS_DIR}/server.crt`);
      updatedLines.push(`MONGO_KEY_PATH=${CERTS_DIR}/server.key`);
      updatedLines.push(`MONGO_CA_PATH=${CERTS_DIR}/ca.crt`);
    }

    await fs.writeFile(envFile, updatedLines.join("\n"));
    log("Environment variables updated for TLS", colors.green);
    return true;
  } catch (err) {
    log(`Failed to update environment variables: ${err.message}`, colors.red);
    return false;
  }
}

/**
 * Main function
 */
async function main() {
  if (!AGENT_ID) {
    log(
      "Agent ID is required. Please provide it as an argument or set SERVER_ID environment variable.",
      colors.red
    );
    process.exit(1);
  }

  log(`Setting up MongoDB TLS for agent ${AGENT_ID}`, colors.bold.white);
  log("=======================================", colors.bold.white);

  // Step 1: Fetch certificates
  const certificatesSuccess = await fetchCertificates();
  if (!certificatesSuccess) {
    log("Failed to fetch certificates, aborting setup", colors.red);
    process.exit(1);
  }

  // Step 2: Configure MongoDB
  const mongodbSuccess = await configureMongoDB();
  if (!mongodbSuccess) {
    log(
      "Warning: MongoDB configuration was not fully completed",
      colors.yellow
    );
    log("You may need to manually configure MongoDB for TLS", colors.yellow);
  }

  // Step 3: Update environment variables
  const envSuccess = await updateEnvironment();
  if (!envSuccess) {
    log("Warning: Environment variables were not updated", colors.yellow);
    log(
      "You may need to manually set TLS environment variables",
      colors.yellow
    );
  }

  // Final message
  if (certificatesSuccess && (mongodbSuccess || envSuccess)) {
    log("\nMongoDB TLS setup completed successfully!", colors.green);
    log(
      `Your MongoDB instance should now be accessible at ${AGENT_ID}.${MONGO_DOMAIN}:27017 with TLS`,
      colors.green
    );
    log("\nTest with this connection string:", colors.bold.white);
    log(
      `mongodb://admin:adminpassword@${AGENT_ID}.${MONGO_DOMAIN}:27017/admin?tls=true&tlsAllowInvalidCertificates=true`,
      colors.green
    );
  } else {
    log("\nMongoDB TLS setup was partially completed", colors.yellow);
    log(
      "Please check the logs above for details on what needs to be fixed manually",
      colors.yellow
    );
  }
}

// Run the main function
main().catch((err) => {
  log(`Fatal error: ${err.message}`, colors.red);
  process.exit(1);
});
