#!/usr/bin/env node
/**
 * Setup MongoDB TLS
 *
 * This script helps agents set up MongoDB with TLS certificates
 * provided by the front server.
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
const axios = require("axios");
const { execSync } = require("child_process");

// Configuration
const AGENT_ID = process.env.SERVER_ID || process.argv[2];
const API_TOKEN = process.env.AGENT_API_TOKEN || process.argv[3];
const FRONT_API_URL = process.env.FRONT_API_URL || "http://localhost:3005";
const CERT_DIR = process.env.CERT_DIR || "/etc/mongodb/certs";

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

async function downloadCertificates() {
  log("Downloading MongoDB TLS certificates from front server...", colors.blue);

  try {
    const response = await axios.get(
      `${FRONT_API_URL}/api/certificates/agent/${AGENT_ID}`,
      {
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
        },
      }
    );

    if (response.data.success && response.data.certificates) {
      const { caCert, serverKey, serverCert } = response.data.certificates;

      // Create certificate directory
      await fs.mkdir(CERT_DIR, { recursive: true });

      // Write certificates to files
      await fs.writeFile(path.join(CERT_DIR, "ca.crt"), caCert);
      await fs.writeFile(path.join(CERT_DIR, "mongodb.key"), serverKey);
      await fs.writeFile(path.join(CERT_DIR, "mongodb.crt"), serverCert);

      // Set permissions
      await fs.chmod(path.join(CERT_DIR, "ca.crt"), 0o644);
      await fs.chmod(path.join(CERT_DIR, "mongodb.key"), 0o600);
      await fs.chmod(path.join(CERT_DIR, "mongodb.crt"), 0o644);

      log("Certificates downloaded and saved successfully", colors.green);
      return true;
    } else {
      log(
        `Failed to download certificates: ${
          response.data.message || "Unknown error"
        }`,
        colors.red
      );
      return false;
    }
  } catch (err) {
    log(`Failed to download certificates: ${err.message}`, colors.red);
    return false;
  }
}

async function updateMongoDBConfig() {
  log("Updating MongoDB configuration for TLS...", colors.blue);

  const configPath = "/etc/mongod.conf";
  let configContent;

  try {
    // Check if config file exists
    try {
      configContent = await fs.readFile(configPath, "utf8");
    } catch (err) {
      // Create a new config file if it doesn't exist
      configContent = `
storage:
  dbPath: /data/db
`;
    }

    // Add TLS configuration
    if (!configContent.includes("net:")) {
      configContent += `
net:
  port: 27017
  bindIp: 0.0.0.0
`;
    }

    if (!configContent.includes("tls:")) {
      configContent += `
net:
  tls:
    mode: requireTLS
    certificateKeyFile: ${path.join(CERT_DIR, "mongodb.key")}
    certificateKeyFilePassword: null
    CAFile: ${path.join(CERT_DIR, "ca.crt")}
    allowConnectionsWithoutCertificates: true
`;
    } else {
      log("TLS configuration already exists, updating...", colors.yellow);
      // Replace existing TLS configuration
      const tlsRegex = /net:\s*tls:[\s\S]*?(?=\n\S|$)/;
      const tlsConfig = `net:
  tls:
    mode: requireTLS
    certificateKeyFile: ${path.join(CERT_DIR, "mongodb.key")}
    certificateKeyFilePassword: null
    CAFile: ${path.join(CERT_DIR, "ca.crt")}
    allowConnectionsWithoutCertificates: true`;

      if (tlsRegex.test(configContent)) {
        configContent = configContent.replace(tlsRegex, tlsConfig);
      } else {
        configContent += "\n" + tlsConfig;
      }
    }

    // Write updated config
    await fs.writeFile(configPath, configContent);
    log("MongoDB configuration updated successfully", colors.green);
    return true;
  } catch (err) {
    log(`Failed to update MongoDB configuration: ${err.message}`, colors.red);
    return false;
  }
}

async function updateDockerComposeConfig() {
  log("Updating Docker Compose configuration for MongoDB TLS...", colors.blue);

  const composeFile = "/opt/cloudlunacy/docker-compose.yml";

  try {
    // Check if compose file exists
    let composeContent;
    try {
      composeContent = await fs.readFile(composeFile, "utf8");
    } catch (err) {
      log(`Docker Compose file not found at ${composeFile}`, colors.red);
      return false;
    }

    // Update MongoDB service with TLS configuration
    if (
      composeContent.includes("mongodb") ||
      composeContent.includes("mongo")
    ) {
      // This is a simple string replacement approach; for production use a YAML parser
      if (!composeContent.includes("command:")) {
        // Add command for TLS
        const mongoRegex = /(mongo.*?)(?:\n\s*\w+:|\n\w+:|\n\s*$)/s;
        const mongoWithCommand = `$1
    command:
      - "--tlsMode=requireTLS"
      - "--tlsCertificateKeyFile=/certs/mongodb.key"
      - "--tlsCAFile=/certs/ca.crt"
      - "--tlsAllowConnectionsWithoutCertificates"
    volumes:
      - ${CERT_DIR}:/certs`;

        composeContent = composeContent.replace(mongoRegex, mongoWithCommand);
      } else {
        log(
          "MongoDB service already has command configuration, please update manually",
          colors.yellow
        );
      }

      // Write updated compose file
      await fs.writeFile(composeFile, composeContent);
      log("Docker Compose configuration updated successfully", colors.green);
      return true;
    } else {
      log("No MongoDB service found in Docker Compose file", colors.yellow);
      return false;
    }
  } catch (err) {
    log(
      `Failed to update Docker Compose configuration: ${err.message}`,
      colors.red
    );
    return false;
  }
}

async function restartMongoDB() {
  log("Restarting MongoDB service...", colors.blue);

  try {
    // Check if running through Docker or directly
    const dockerRunning =
      execSync("docker ps | grep mongo").toString().trim() !== "";

    if (dockerRunning) {
      execSync(
        "docker-compose -f /opt/cloudlunacy/docker-compose.yml restart mongodb"
      );
    } else {
      execSync("systemctl restart mongod || service mongod restart");
    }

    log("MongoDB restarted successfully", colors.green);
    return true;
  } catch (err) {
    log(`Failed to restart MongoDB: ${err.message}`, colors.red);
    return false;
  }
}

// Main function
async function main() {
  if (!AGENT_ID || !API_TOKEN) {
    log("Usage: node setup-mongodb-tls.js <AGENT_ID> <API_TOKEN>", colors.red);
    process.exit(1);
  }

  log(`Setting up MongoDB TLS for agent ${AGENT_ID}`, colors.bold.white);

  const certSuccess = await downloadCertificates();
  if (!certSuccess) {
    log("Certificate download failed, aborting setup", colors.red);
    process.exit(1);
  }

  const configSuccess = await updateMongoDBConfig();
  const dockerSuccess = await updateDockerComposeConfig();

  if (configSuccess || dockerSuccess) {
    const restartSuccess = await restartMongoDB();

    if (restartSuccess) {
      log("\nMongoDB TLS setup completed successfully!", colors.green);
      log(
        "Your MongoDB instance should now accept secure connections.",
        colors.green
      );
    } else {
      log(
        "\nMongoDB TLS setup partially completed, but restart failed.",
        colors.yellow
      );
      log("Please restart MongoDB manually to apply changes.", colors.yellow);
    }
  } else {
    log("\nMongoDB TLS configuration failed.", colors.red);
    log(
      "Please configure MongoDB manually to use the downloaded certificates.",
      colors.yellow
    );
  }
}

main().catch((err) => {
  log(`Fatal error: ${err.message}`, colors.red);
  process.exit(1);
});
