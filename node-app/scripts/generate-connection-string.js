#!/usr/bin/env node
/**
 * Generate MongoDB Connection String
 *
 * This script generates the correct MongoDB connection string based on
 * the server configuration and TLS settings.
 */

require("dotenv").config();
const { execSync } = require("child_process");
const net = require("net");

// Configuration
const AGENT_ID = process.argv[2] || "240922b9-4d3b-4692-8d1c-1884d423092a";
const TARGET_IP = process.argv[3] || "128.140.53.203";
const MONGO_DOMAIN = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
const MONGO_PORT = 27017;
const USERNAME = process.argv[4] || "admin";
const PASSWORD = process.argv[5] || "adminpassword";
const DATABASE = process.argv[6] || "admin";

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
  log(`${colors.bold}MongoDB Connection String Generator${colors.reset}`);
  log("=====================================");

  const domain = `${AGENT_ID}.${MONGO_DOMAIN}`;
  log(`Generating connection string for ${domain}`, colors.blue);

  try {
    // Check if we can connect directly to the target IP
    log(
      `Testing direct connection to ${TARGET_IP}:${MONGO_PORT}...`,
      colors.blue
    );
    const directTLS = await checkMongoDBTLS(TARGET_IP, MONGO_PORT);

    // Check if we can connect through Traefik
    log(
      `Testing connection through Traefik at ${domain}:${MONGO_PORT}...`,
      colors.blue
    );
    const traefikTLS = await checkMongoDBTLS(domain, MONGO_PORT);

    // Generate connection strings
    log("\nConnection Strings:", colors.bold);

    // Direct connection string
    if (directTLS) {
      log("\nDirect connection with TLS:", colors.yellow);
      log(
        `mongodb://${USERNAME}:${PASSWORD}@${TARGET_IP}:${MONGO_PORT}/${DATABASE}?ssl=true&authSource=admin&tlsAllowInvalidCertificates=true`,
        colors.green
      );
    } else {
      log("\nDirect connection without TLS:", colors.yellow);
      log(
        `mongodb://${USERNAME}:${PASSWORD}@${TARGET_IP}:${MONGO_PORT}/${DATABASE}?authSource=admin`,
        colors.green
      );
    }

    // Traefik connection string
    if (traefikTLS) {
      log("\nTraefik connection with TLS:", colors.yellow);
      log(
        `mongodb://${USERNAME}:${PASSWORD}@${domain}:${MONGO_PORT}/${DATABASE}?ssl=true&authSource=admin&tlsAllowInvalidCertificates=true`,
        colors.green
      );
    } else {
      log("\nTraefik connection without TLS:", colors.yellow);
      log(
        `mongodb://${USERNAME}:${PASSWORD}@${domain}:${MONGO_PORT}/${DATABASE}?authSource=admin`,
        colors.green
      );
    }

    // Recommendations
    log("\nRecommendations:", colors.bold);

    if (directTLS !== traefikTLS) {
      log(
        "The TLS configuration between direct connection and Traefik connection doesn't match.",
        colors.red
      );
      log(
        "Run the fix-mongodb-tls.js script to update Traefik configuration:",
        colors.blue
      );
      log("node scripts/fix-mongodb-tls.js", colors.green);
    } else {
      log(
        "TLS configuration is consistent between direct and Traefik connections.",
        colors.green
      );
    }
  } catch (err) {
    log(`Error: ${err.message}`, colors.red);
    process.exit(1);
  }
}

main();
