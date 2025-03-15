#!/usr/bin/env node
/**
 * Generate Agent Certificates
 *
 * This script directly generates certificates for an agent without going through the API
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
const { execSync } = require("child_process");

// Configuration
const AGENT_ID = process.argv[2];
const OUTPUT_DIR = process.argv[3] || "./certs";

if (!AGENT_ID) {
  console.error(
    "Usage: node generate-agent-certificates.js <agent-id> [output-dir]"
  );
  process.exit(1);
}

// Ensure output directory exists
async function ensureDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
    console.log(`Directory ${dir} created or already exists`);
  } catch (err) {
    console.error(`Failed to create directory ${dir}: ${err.message}`);
    throw err;
  }
}

// Generate CA certificate if it doesn't exist
async function generateCA(certsDir) {
  const caKeyPath = path.join(certsDir, "ca.key");
  const caCertPath = path.join(certsDir, "ca.crt");

  try {
    // Check if CA already exists
    await fs.access(caKeyPath);
    await fs.access(caCertPath);
    console.log("CA certificate already exists");
    return;
  } catch (err) {
    // CA doesn't exist, generate it
    console.log("Generating new CA certificate...");

    // Generate CA key
    execSync(`openssl genrsa -out ${caKeyPath} 4096`);

    // Generate CA certificate
    execSync(
      `openssl req -x509 -new -nodes -key ${caKeyPath} -sha256 -days 3650 -out ${caCertPath} -subj "/CN=CloudLunacy CA/O=CloudLunacy/C=UK"`
    );

    // Set permissions
    await fs.chmod(caKeyPath, 0o600);
    await fs.chmod(caCertPath, 0o644);

    console.log("CA certificate generated successfully");
  }
}

// Generate agent certificate
async function generateAgentCertificate(agentId, certsDir) {
  console.log(`Generating certificate for agent ${agentId}...`);

  const caKeyPath = path.join(certsDir, "ca.key");
  const caCertPath = path.join(certsDir, "ca.crt");
  const serverKeyPath = path.join(certsDir, "server.key");
  const serverCertPath = path.join(certsDir, "server.crt");
  const serverCsrPath = path.join(certsDir, "server.csr");
  const configPath = path.join(certsDir, "openssl.cnf");

  try {
    // Create OpenSSL config
    const domain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
    const serverName = `${agentId}.${domain}`;

    const opensslConfig = `
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
req_extensions = v3_req

[dn]
CN = ${serverName}
O = CloudLunacy
C = UK

[v3_req]
subjectAltName = @alt_names
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt_names]
DNS.1 = ${serverName}
DNS.2 = *.${domain}
DNS.3 = localhost
IP.1 = 127.0.0.1
    `;

    await fs.writeFile(configPath, opensslConfig);

    // Generate server key
    execSync(`openssl genrsa -out ${serverKeyPath} 2048`);

    // Generate CSR with config
    execSync(
      `openssl req -new -key ${serverKeyPath} -out ${serverCsrPath} -config ${configPath}`
    );

    // Sign the certificate with our CA
    execSync(
      `openssl x509 -req -in ${serverCsrPath} -CA ${caCertPath} -CAkey ${caKeyPath} -CAcreateserial -out ${serverCertPath} -days 825 -extensions v3_req -extfile ${configPath}`
    );

    // Create PEM file (combined key and cert)
    const serverKey = await fs.readFile(serverKeyPath, "utf8");
    const serverCert = await fs.readFile(serverCertPath, "utf8");
    await fs.writeFile(
      path.join(certsDir, "server.pem"),
      serverKey + serverCert
    );

    // Set proper permissions
    await fs.chmod(serverKeyPath, 0o600);
    await fs.chmod(serverCertPath, 0o644);
    await fs.chmod(path.join(certsDir, "server.pem"), 0o600);

    console.log("Agent certificate generated successfully");

    return {
      success: true,
      caCert: await fs.readFile(caCertPath, "utf8"),
      serverKey,
      serverCert,
    };
  } catch (err) {
    console.error(`Failed to generate certificate: ${err.message}`);
    return {
      success: false,
      error: err.message,
    };
  }
}

// Main function
async function main() {
  try {
    await ensureDir(OUTPUT_DIR);
    await generateCA(OUTPUT_DIR);
    const result = await generateAgentCertificate(AGENT_ID, OUTPUT_DIR);

    if (result.success) {
      console.log("Certificates generated successfully:");
      console.log(`- CA Certificate: ${path.join(OUTPUT_DIR, "ca.crt")}`);
      console.log(`- Server Key: ${path.join(OUTPUT_DIR, "server.key")}`);
      console.log(
        `- Server Certificate: ${path.join(OUTPUT_DIR, "server.crt")}`
      );
      console.log(`- Server PEM: ${path.join(OUTPUT_DIR, "server.pem")}`);
    } else {
      console.error(`Certificate generation failed: ${result.error}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  }
}

main();
