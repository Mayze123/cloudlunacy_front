#!/usr/bin/env node
/**
 * MongoDB Connection Tester
 *
 * This script tests MongoDB connections with different configurations
 * to help diagnose and verify TLS termination setup.
 */

const { MongoClient } = require("mongodb");
const dns = require("dns").promises;
const net = require("net");
const tls = require("tls");
const { execSync } = require("child_process");

// Configuration - update these values
const AGENT_ID = process.argv[2] || "240922b9-4d3b-4692-8d1c-1884d423092a";
const MONGO_DOMAIN = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
const MONGO_USERNAME = "admin";
const MONGO_PASSWORD = "adminpassword";
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

function warning(message) {
  log(`⚠ ${message}`, colors.yellow);
}

function header(title) {
  log(`\n${colors.bold}${colors.blue}${title}${colors.reset}`);
  log("=".repeat(title.length));
}

// Test DNS resolution
async function testDnsResolution() {
  header("DNS Resolution Test");

  const hostname = `${AGENT_ID}.${MONGO_DOMAIN}`;
  log(`Testing DNS resolution for ${hostname}...`);

  try {
    const addresses = await dns.resolve4(hostname);
    success(
      `DNS resolution successful: ${hostname} -> ${addresses.join(", ")}`
    );
    return addresses[0];
  } catch (err) {
    error(`DNS resolution failed: ${err.message}`);
    return null;
  }
}

// Test TCP connection
async function testTcpConnection(host) {
  header("TCP Connection Test");

  log(`Testing TCP connection to ${host}:${MONGO_PORT}...`);

  return new Promise((resolve) => {
    const socket = net.createConnection({
      host,
      port: MONGO_PORT,
      timeout: 5000,
    });

    socket.on("connect", () => {
      success(`TCP connection successful to ${host}:${MONGO_PORT}`);
      socket.end();
      resolve(true);
    });

    socket.on("timeout", () => {
      error(`TCP connection timed out to ${host}:${MONGO_PORT}`);
      socket.destroy();
      resolve(false);
    });

    socket.on("error", (err) => {
      error(`TCP connection failed: ${err.message}`);
      resolve(false);
    });
  });
}

// Test TLS handshake
async function testTlsHandshake(host) {
  header("TLS Handshake Test");

  log(`Testing TLS handshake with ${host}:${MONGO_PORT}...`);

  return new Promise((resolve) => {
    const socket = tls.connect({
      host,
      port: MONGO_PORT,
      rejectUnauthorized: false,
      timeout: 5000,
    });

    socket.on("secureConnect", () => {
      success(`TLS handshake successful with ${host}:${MONGO_PORT}`);
      const protocol = socket.getProtocol();
      log(`TLS Protocol: ${protocol}`);
      const cert = socket.getPeerCertificate();
      log(`Certificate Subject: ${cert.subject.CN}`);
      log(`Certificate Issuer: ${cert.issuer.CN}`);
      log(
        `Certificate Valid Until: ${new Date(cert.valid_to).toLocaleString()}`
      );
      socket.end();
      resolve(true);
    });

    socket.on("timeout", () => {
      error(`TLS handshake timed out with ${host}:${MONGO_PORT}`);
      socket.destroy();
      resolve(false);
    });

    socket.on("error", (err) => {
      error(`TLS handshake failed: ${err.message}`);
      resolve(false);
    });
  });
}

// Test MongoDB connection with TLS
async function testMongoDbConnectionWithTls(host) {
  header("MongoDB Connection Test (with TLS)");

  const uri = `mongodb://${MONGO_USERNAME}:${MONGO_PASSWORD}@${host}:${MONGO_PORT}/admin?ssl=true&authSource=admin&tlsAllowInvalidCertificates=true`;
  log(`Testing MongoDB connection with TLS: ${uri}`);

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
  });

  try {
    await client.connect();
    const adminDb = client.db("admin");
    const result = await adminDb.command({ ping: 1 });
    success(
      `MongoDB connection with TLS successful: ${JSON.stringify(result)}`
    );

    // Get server info
    const serverInfo = await adminDb.command({ buildInfo: 1 });
    log(`MongoDB Version: ${serverInfo.version}`);

    await client.close();
    return true;
  } catch (err) {
    error(`MongoDB connection with TLS failed: ${err.message}`);
    return false;
  }
}

// Test MongoDB connection without TLS
async function testMongoDbConnectionWithoutTls(host) {
  header("MongoDB Connection Test (without TLS)");

  const uri = `mongodb://${MONGO_USERNAME}:${MONGO_PASSWORD}@${host}:${MONGO_PORT}/admin`;
  log(`Testing MongoDB connection without TLS: ${uri}`);

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
  });

  try {
    await client.connect();
    const adminDb = client.db("admin");
    const result = await adminDb.command({ ping: 1 });
    success(
      `MongoDB connection without TLS successful: ${JSON.stringify(result)}`
    );
    await client.close();
    return true;
  } catch (err) {
    error(`MongoDB connection without TLS failed: ${err.message}`);
    return false;
  }
}

// Suggest fixes based on test results
async function suggestFixes(results) {
  header("Recommendations");

  if (!results.dnsOk) {
    warning("DNS resolution failed. Check the following:");
    log("1. Ensure the domain is properly registered");
    log("2. Verify that Traefik is configured to handle the subdomain");
    log("3. Check if the agent is properly registered with the front server");
    return;
  }

  if (!results.tcpOk) {
    warning("TCP connection failed. Check the following:");
    log("1. Ensure MongoDB is running on the agent");
    log("2. Verify that port 27017 is open on the agent");
    log("3. Check if Traefik is properly routing traffic to the agent");
    return;
  }

  if (results.tlsOk && results.mongoTlsOk) {
    success(
      "All tests passed! Your MongoDB TLS termination is working correctly."
    );
    log("Connection string for clients:");
    log(
      `mongodb://${MONGO_USERNAME}:${MONGO_PASSWORD}@${AGENT_ID}.${MONGO_DOMAIN}:${MONGO_PORT}/admin?ssl=true&authSource=admin&tlsAllowInvalidCertificates=true`
    );
    return;
  }

  if (!results.tlsOk) {
    warning("TLS handshake failed. Check the following:");
    log("1. Ensure Traefik is configured for TLS termination");
    log("2. Verify that the certificate resolver is working");
    log("3. Check if the MongoDB entrypoint in Traefik has TLS enabled");
  }

  if (!results.mongoTlsOk && !results.mongoNoTlsOk) {
    warning("Both MongoDB connection tests failed. Check the following:");
    log("1. Verify MongoDB credentials (username/password)");
    log("2. Ensure MongoDB is properly configured on the agent");
    log("3. Check MongoDB logs for authentication or connection issues");
  } else if (!results.mongoTlsOk && results.mongoNoTlsOk) {
    warning("MongoDB works without TLS but fails with TLS. This suggests:");
    log("1. Traefik is not properly terminating TLS");
    log("2. Try using the non-TLS connection string:");
    log(
      `mongodb://${MONGO_USERNAME}:${MONGO_PASSWORD}@${AGENT_ID}.${MONGO_DOMAIN}:${MONGO_PORT}/admin`
    );
  } else if (results.mongoTlsOk && !results.mongoNoTlsOk) {
    success(
      "MongoDB works with TLS but not without TLS. This is expected if TLS is required."
    );
    log("Use the TLS connection string:");
    log(
      `mongodb://${MONGO_USERNAME}:${MONGO_PASSWORD}@${AGENT_ID}.${MONGO_DOMAIN}:${MONGO_PORT}/admin?ssl=true&authSource=admin&tlsAllowInvalidCertificates=true`
    );
  }
}

// Main function
async function main() {
  log(`${colors.bold}MongoDB Connection Tester${colors.reset}`);
  log(`Testing MongoDB connection for agent: ${AGENT_ID}`);
  log(`Domain: ${MONGO_DOMAIN}`);

  const results = {
    dnsOk: false,
    tcpOk: false,
    tlsOk: false,
    mongoTlsOk: false,
    mongoNoTlsOk: false,
  };

  // Step 1: Test DNS resolution
  const resolvedIp = await testDnsResolution();
  results.dnsOk = !!resolvedIp;

  if (!resolvedIp) {
    error("DNS resolution failed. Cannot continue with further tests.");
    await suggestFixes(results);
    return;
  }

  // Step 2: Test TCP connection
  results.tcpOk = await testTcpConnection(`${AGENT_ID}.${MONGO_DOMAIN}`);

  if (!results.tcpOk) {
    error("TCP connection failed. Cannot continue with further tests.");
    await suggestFixes(results);
    return;
  }

  // Step 3: Test TLS handshake
  results.tlsOk = await testTlsHandshake(`${AGENT_ID}.${MONGO_DOMAIN}`);

  // Step 4: Test MongoDB connection with TLS
  results.mongoTlsOk = await testMongoDbConnectionWithTls(
    `${AGENT_ID}.${MONGO_DOMAIN}`
  );

  // Step 5: Test MongoDB connection without TLS
  results.mongoNoTlsOk = await testMongoDbConnectionWithoutTls(
    `${AGENT_ID}.${MONGO_DOMAIN}`
  );

  // Summary
  header("Test Results Summary");
  log(`DNS Resolution: ${results.dnsOk ? "✓" : "✗"}`);
  log(`TCP Connection: ${results.tcpOk ? "✓" : "✗"}`);
  log(`TLS Handshake: ${results.tlsOk ? "✓" : "✗"}`);
  log(`MongoDB with TLS: ${results.mongoTlsOk ? "✓" : "✗"}`);
  log(`MongoDB without TLS: ${results.mongoNoTlsOk ? "✓" : "✗"}`);

  // Suggest fixes
  await suggestFixes(results);
}

// Run the main function
main().catch((err) => {
  console.error(`${colors.red}Fatal error: ${err.message}${colors.reset}`);
  process.exit(1);
});
