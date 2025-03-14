#!/usr/bin/env node
/**
 * MongoDB TLS Configuration Checker
 *
 * This script checks if a MongoDB server is properly configured for TLS
 * and helps diagnose connection issues.
 */

const { execSync } = require("child_process");
const net = require("net");
const tls = require("tls");
const fs = require("fs");

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
  log(`\n${message}`, colors.bold);
}

function execCommand(command) {
  try {
    return execSync(command, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

// Test functions
async function testTcpConnection(host, port) {
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

async function testTlsConnection(host, port) {
  return new Promise((resolve) => {
    const options = {
      host: host,
      port: port,
      rejectUnauthorized: false,
      requestCert: true,
      timeout: 5000,
    };

    const socket = tls.connect(options, () => {
      if (socket.authorized) {
        success(
          `TLS connection to ${host}:${port} successful with valid certificate`
        );
      } else {
        warning(
          `TLS connection to ${host}:${port} successful but with unauthorized certificate: ${socket.authorizationError}`
        );
      }

      // Check if the server presented a certificate
      const cert = socket.getPeerCertificate();
      if (cert && Object.keys(cert).length > 0) {
        info(`Server certificate information:`);
        console.log(
          `  Subject: ${cert.subject ? JSON.stringify(cert.subject) : "N/A"}`
        );
        console.log(
          `  Issuer: ${cert.issuer ? JSON.stringify(cert.issuer) : "N/A"}`
        );
        console.log(`  Valid from: ${cert.valid_from || "N/A"}`);
        console.log(`  Valid to: ${cert.valid_to || "N/A"}`);
      } else {
        warning(`Server did not present a certificate`);
      }

      socket.end();
      resolve(true);
    });

    socket.on("timeout", () => {
      error(`TLS connection to ${host}:${port} timed out`);
      socket.destroy();
      resolve(false);
    });

    socket.on("error", (err) => {
      error(`TLS connection to ${host}:${port} failed: ${err.message}`);
      socket.destroy();
      resolve(false);
    });

    info(`Attempting TLS connection to ${host}:${port}...`);
  });
}

async function testMongoDBConnection(host, port, useTLS = true) {
  const connectionString = useTLS
    ? `mongodb://admin:adminpassword@${host}:${port}/admin?ssl=true&authSource=admin&tlsAllowInvalidCertificates=true`
    : `mongodb://admin:adminpassword@${host}:${port}/admin?authSource=admin`;

  info(`Testing MongoDB connection: ${connectionString}`);

  try {
    // Check if mongosh is available
    try {
      execSync("which mongosh", { stdio: "ignore" });
    } catch (err) {
      warning("mongosh command not found, trying mongo instead");
      try {
        execSync("which mongo", { stdio: "ignore" });
      } catch (err) {
        error("Neither mongosh nor mongo commands are available");
        return false;
      }

      // Use mongo command
      const result = execCommand(
        `mongo "${connectionString}" --eval "db.serverStatus()" --quiet`
      );
      if (result.includes("Error:")) {
        error(`MongoDB connection failed: ${result}`);
        return false;
      } else {
        success("MongoDB connection successful");
        return true;
      }
    }

    // Use mongosh command
    const result = execCommand(
      `mongosh "${connectionString}" --eval "db.serverStatus()" --quiet`
    );
    if (
      result.includes("Error:") ||
      result.includes("MongoServerSelectionError")
    ) {
      error(`MongoDB connection failed: ${result}`);
      return false;
    } else {
      success("MongoDB connection successful");
      return true;
    }
  } catch (err) {
    error(`Error testing MongoDB connection: ${err.message}`);
    return false;
  }
}

async function checkMongoDBServerConfig() {
  header("Checking MongoDB Server Configuration");

  // Try to connect directly to the MongoDB server
  info(`Checking MongoDB server at ${TARGET_IP}:${MONGO_PORT}`);

  // First check TCP connection
  const tcpConnected = await testTcpConnection(TARGET_IP, MONGO_PORT);
  if (!tcpConnected) {
    error("Cannot establish TCP connection to MongoDB server");
    return false;
  }

  // Then check TLS connection
  const tlsConnected = await testTlsConnection(TARGET_IP, MONGO_PORT);

  // Try MongoDB connection with and without TLS
  info("Testing MongoDB connection with TLS...");
  const tlsMongoConnected = await testMongoDBConnection(
    TARGET_IP,
    MONGO_PORT,
    true
  );

  if (!tlsMongoConnected) {
    info("Testing MongoDB connection without TLS...");
    const plainMongoConnected = await testMongoDBConnection(
      TARGET_IP,
      MONGO_PORT,
      false
    );

    if (plainMongoConnected) {
      warning(
        "MongoDB server is running WITHOUT TLS but we are trying to connect WITH TLS"
      );
      info("This is likely the cause of the connection issues");
      return false;
    }
  }

  return tlsConnected || tlsMongoConnected;
}

async function checkTraefikTLSPassthrough() {
  header("Checking Traefik TLS Passthrough Configuration");

  // Check if Traefik is running
  const traefikRunning = execCommand("docker ps | grep traefik").includes(
    "traefik"
  );
  if (!traefikRunning) {
    error("Traefik container is not running");
    return false;
  }

  success("Traefik container is running");

  // Check dynamic.yml configuration
  const configPaths = [
    "/etc/traefik/dynamic.yml",
    "/app/config/dynamic.yml",
    "./config/dynamic.yml",
    "/opt/cloudlunacy_front/config/dynamic.yml",
  ];

  let configFound = false;
  let configContent = "";

  for (const path of configPaths) {
    try {
      configContent = execCommand(`cat ${path} 2>/dev/null`);
      if (configContent && !configContent.startsWith("Error:")) {
        configFound = true;
        info(`Found dynamic.yml at ${path}`);
        break;
      }
    } catch (err) {
      // Continue to next path
    }
  }

  if (!configFound) {
    error("Could not find dynamic.yml configuration file");
    return false;
  }

  // Check for TLS passthrough configuration
  const hasCatchallRouter = configContent.includes("mongodb-catchall");
  const hasTlsPassthrough = configContent.includes("passthrough: true");

  if (hasCatchallRouter) {
    success("MongoDB catchall router is configured");
  } else {
    error("MongoDB catchall router is missing");
  }

  if (hasTlsPassthrough) {
    success("TLS passthrough is configured");
  } else {
    error("TLS passthrough is not configured");
    return false;
  }

  // Check for specific agent router
  const agentRouterPattern = new RegExp(`mongodb-${AGENT_ID}`);
  const hasAgentRouter = agentRouterPattern.test(configContent);

  if (hasAgentRouter) {
    success(`Agent router for ${AGENT_ID} is configured`);
  } else {
    warning(`Agent router for ${AGENT_ID} is not configured`);
  }

  return hasCatchallRouter && hasTlsPassthrough;
}

async function testConnectionThroughTraefik() {
  header("Testing Connection Through Traefik");

  const hostname = `${AGENT_ID}.${MONGO_DOMAIN}`;
  info(`Testing connection to ${hostname}:${MONGO_PORT}`);

  // Test TCP connection
  const tcpConnected = await testTcpConnection(hostname, MONGO_PORT);
  if (!tcpConnected) {
    return false;
  }

  // Test TLS connection
  const tlsConnected = await testTlsConnection(hostname, MONGO_PORT);

  // Test MongoDB connection
  const mongoConnected = await testMongoDBConnection(
    hostname,
    MONGO_PORT,
    true
  );

  return mongoConnected;
}

async function suggestFixes() {
  header("Suggested Fixes");

  // Check if MongoDB is actually running with TLS
  info(
    "1. Verify that MongoDB is running with TLS enabled on the target server"
  );
  info("   Command to check: mongod --version");

  // Check MongoDB configuration
  info("2. Check MongoDB configuration on the target server:");
  info("   - Look for TLS/SSL settings in mongod.conf");
  info("   - Ensure certificates are properly configured");

  // Try connecting without TLS
  info("3. If MongoDB is NOT running with TLS, you have two options:");
  info("   a. Enable TLS on the MongoDB server (recommended)");
  info("   b. Update your connection string to not use TLS:");
  info(
    "      mongodb://admin:adminpassword@240922b9-4d3b-4692-8d1c-1884d423092a.mongodb.cloudlunacy.uk:27017/admin"
  );

  // Check firewall
  info("4. Ensure firewall allows MongoDB connections:");
  info("   - Check UFW: sudo ufw status");
  info("   - Allow port: sudo ufw allow 27017/tcp");

  // Check Traefik logs
  info("5. Check Traefik logs for more details:");
  info("   docker logs traefik | grep -i tls");
}

// Main function
async function main() {
  console.log(`${colors.bold}MongoDB TLS Configuration Checker${colors.reset}`);
  console.log("=======================================");

  // Step 1: Check MongoDB server configuration
  const serverConfigOk = await checkMongoDBServerConfig();

  // Step 2: Check Traefik TLS passthrough configuration
  const traefikConfigOk = await checkTraefikTLSPassthrough();

  // Step 3: Test connection through Traefik
  const traefikConnectionOk = await testConnectionThroughTraefik();

  // Summary
  header("Summary");

  if (serverConfigOk) {
    success("MongoDB server appears to be properly configured for TLS");
  } else {
    error("MongoDB server may not be properly configured for TLS");
  }

  if (traefikConfigOk) {
    success("Traefik TLS passthrough is properly configured");
  } else {
    error("Traefik TLS passthrough configuration has issues");
  }

  if (traefikConnectionOk) {
    success("Connection through Traefik is working");
  } else {
    error("Connection through Traefik is not working");
  }

  // Suggest fixes if there are issues
  if (!serverConfigOk || !traefikConfigOk || !traefikConnectionOk) {
    await suggestFixes();
  }
}

main().catch((err) => {
  console.error(`${colors.red}Fatal error: ${err.message}${colors.reset}`);
  process.exit(1);
});
