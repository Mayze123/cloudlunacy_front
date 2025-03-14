#!/usr/bin/env node
/**
 * Advanced MongoDB Connection Diagnostics
 *
 * This script performs comprehensive diagnostics on MongoDB connectivity
 * through Traefik, including DNS, TLS, and network tests.
 */

const { execSync } = require("child_process");
const net = require("net");
const dns = require("dns").promises;
const fs = require("fs").promises;
const yaml = require("yaml");
const path = require("path");

// Configuration
const AGENT_ID = process.argv[2] || "240922b9-4d3b-4692-8d1c-1884d423092a";
const MONGO_DOMAIN = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
const MONGO_PORT = 27017;
const TARGET_IP = process.argv[3]; // Optional target IP to test direct connection

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

    // Try to check if the domain exists at all
    try {
      const rootDomain = MONGO_DOMAIN;
      const rootAddresses = await dns.resolve4(rootDomain);
      info(
        `Root domain ${rootDomain} resolves to: ${rootAddresses.join(", ")}`
      );
      warning(
        `The subdomain ${hostname} doesn't resolve, but the root domain does`
      );
    } catch (rootErr) {
      error(
        `Root domain ${MONGO_DOMAIN} also fails to resolve: ${rootErr.message}`
      );
    }

    return null;
  }
}

async function testTcpConnection(host, port, description = "") {
  const hostDesc = description || host;
  header(`Testing TCP connection to ${hostDesc}:${port}`);
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(5000);

    socket.on("connect", () => {
      success(`Successfully connected to ${hostDesc}:${port}`);
      socket.destroy();
      resolve(true);
    });

    socket.on("timeout", () => {
      error(`Connection to ${hostDesc}:${port} timed out`);
      socket.destroy();
      resolve(false);
    });

    socket.on("error", (err) => {
      error(`Connection error: ${err.message}`);
      socket.destroy();
      resolve(false);
    });

    info(`Attempting to connect to ${hostDesc}:${port}...`);
    socket.connect(port, host);
  });
}

async function checkTraefikConfig() {
  header("Checking Traefik configuration");

  // Check if Traefik is running
  const traefikStatus = execCommand("docker ps | grep traefik");
  if (traefikStatus.includes("traefik")) {
    success("Traefik container is running");
  } else {
    error("Traefik container is not running");
    return false;
  }

  // Check if port 27017 is exposed
  const portExposed = execCommand("docker port traefik | grep 27017");
  if (portExposed && !portExposed.startsWith("Error")) {
    success(`MongoDB port is exposed: ${portExposed.trim()}`);
  } else {
    error("MongoDB port 27017 is not exposed in Traefik");

    // Check docker-compose.yml
    const dockerComposeContent = await readFile(
      "/app/docker-compose.yml",
      "./docker-compose.yml",
      "/opt/cloudlunacy_front/docker-compose.yml"
    );
    if (dockerComposeContent) {
      if (dockerComposeContent.includes("27017:27017")) {
        info("Port 27017 is correctly mapped in docker-compose.yml");
        warning(
          "Port mapping exists in docker-compose.yml but not in running container"
        );
        info("You may need to restart the Traefik container");
      } else {
        warning("Port 27017 is not correctly mapped in docker-compose.yml");
        info(
          'You should update docker-compose.yml to include "27017:27017" in the ports section'
        );
      }
    }
  }

  // Check dynamic configuration
  const dynamicConfig = await readFile(
    "/etc/traefik/dynamic.yml",
    "/app/config/dynamic.yml",
    "./config/dynamic.yml"
  );

  if (!dynamicConfig) {
    error("Could not read dynamic.yml configuration file");
    return false;
  }

  // Parse YAML
  try {
    const config = yaml.parse(dynamicConfig);

    // Check TCP routers
    if (config.tcp && config.tcp.routers) {
      // Check catchall router
      if (config.tcp.routers["mongodb-catchall"]) {
        const catchallRouter = config.tcp.routers["mongodb-catchall"];
        success("MongoDB catchall router is configured");

        // Check TLS passthrough
        if (catchallRouter.tls && catchallRouter.tls.passthrough === true) {
          success("TLS passthrough is correctly configured in catchall router");
        } else {
          error(
            "TLS passthrough is not correctly configured in catchall router"
          );
          info("The catchall router should have: tls: { passthrough: true }");
        }
      } else {
        error("MongoDB catchall router is not configured");
      }

      // Check agent-specific router
      const agentRouterName = `mongodb-${AGENT_ID}`;
      if (config.tcp.routers[agentRouterName]) {
        const agentRouter = config.tcp.routers[agentRouterName];
        success(`Agent-specific MongoDB router for ${AGENT_ID} is configured`);

        // Check rule
        const expectedRule = `HostSNI(\`${AGENT_ID}.${MONGO_DOMAIN}\`)`;
        if (agentRouter.rule === expectedRule) {
          success("Router rule is correctly configured");
        } else {
          error(
            `Router rule is incorrect. Expected: ${expectedRule}, Got: ${agentRouter.rule}`
          );
        }

        // Check TLS passthrough
        if (agentRouter.tls && agentRouter.tls.passthrough === true) {
          success("TLS passthrough is correctly configured in agent router");
        } else {
          error("TLS passthrough is not correctly configured in agent router");
          info("The agent router should have: tls: { passthrough: true }");
        }

        // Check service
        const serviceName = agentRouter.service;
        if (
          serviceName &&
          config.tcp.services &&
          config.tcp.services[serviceName]
        ) {
          const service = config.tcp.services[serviceName];
          success(`Service ${serviceName} is configured`);

          // Check servers
          if (
            service.loadBalancer &&
            service.loadBalancer.servers &&
            service.loadBalancer.servers.length > 0
          ) {
            const server = service.loadBalancer.servers[0];
            success(`Target server is configured: ${server.address}`);

            // Extract target IP
            const targetIp = server.address.split(":")[0];
            info(
              `Target IP: ${targetIp}, Port: ${server.address.split(":")[1]}`
            );

            // Store for later testing
            global.targetIp = targetIp;
          } else {
            error("No servers configured in the service");
          }
        } else {
          error(`Service ${serviceName} is not configured`);
        }
      } else {
        error(
          `Agent-specific MongoDB router for ${AGENT_ID} is not configured`
        );
      }
    } else {
      error("No TCP routers configured in dynamic.yml");
    }
  } catch (err) {
    error(`Error parsing dynamic.yml: ${err.message}`);
    return false;
  }

  return true;
}

async function readFile(...paths) {
  for (const filePath of paths) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (err) {
      // Try next path
    }
  }
  return null;
}

async function testDirectConnection(targetIp) {
  if (!targetIp) {
    warning("No target IP provided, skipping direct connection test");
    return false;
  }

  header(`Testing direct connection to MongoDB at ${targetIp}:27017`);

  // Test TCP connection first
  const tcpResult = await testTcpConnection(targetIp, 27017, "MongoDB server");

  if (!tcpResult) {
    error("Cannot establish TCP connection to MongoDB server");
    return false;
  }

  // Try MongoDB connection without TLS
  info("Testing MongoDB connection without TLS...");
  const noTlsResult = execCommand(
    `timeout 5 mongosh "mongodb://admin:adminpassword@${targetIp}:27017/admin" --eval "db.serverStatus()" 2>&1 || echo "Connection failed"`
  );

  if (!noTlsResult.includes("Connection failed")) {
    success("Direct MongoDB connection without TLS succeeded");
    return true;
  } else {
    info("Direct connection without TLS failed, trying with TLS...");
  }

  // Try MongoDB connection with TLS
  const tlsResult = execCommand(
    `timeout 5 mongosh "mongodb://admin:adminpassword@${targetIp}:27017/admin?ssl=true&tlsAllowInvalidCertificates=true" --eval "db.serverStatus()" 2>&1 || echo "Connection failed"`
  );

  if (!tlsResult.includes("Connection failed")) {
    success("Direct MongoDB connection with TLS succeeded");
    return true;
  } else {
    error("Direct MongoDB connection failed with and without TLS");
    return false;
  }
}

async function testTraefikConnection() {
  header("Testing MongoDB connection through Traefik");
  const hostname = `${AGENT_ID}.${MONGO_DOMAIN}`;
  const connectionString = `mongodb://admin:adminpassword@${hostname}:${MONGO_PORT}/admin?ssl=true&authSource=admin&tlsAllowInvalidCertificates=true`;

  info(`Connection string: ${connectionString}`);

  // Test with verbose logging
  const result = execCommand(
    `timeout 10 mongosh "${connectionString}" --verbose --eval "db.serverStatus()" 2>&1 || echo "Connection failed"`
  );

  console.log("\nConnection test output:");
  console.log("------------------------");
  console.log(result);
  console.log("------------------------\n");

  if (result.includes("Connection failed")) {
    error("MongoDB connection through Traefik failed");
    return false;
  } else {
    success("MongoDB connection through Traefik succeeded");
    return true;
  }
}

async function checkFirewallRules() {
  header("Checking firewall rules");

  // Check if firewall is active
  const firewallStatus = execCommand(
    'ufw status 2>/dev/null || firewall-cmd --state 2>/dev/null || echo "Unknown"'
  );

  if (firewallStatus.includes("active") || firewallStatus.includes("running")) {
    warning("Firewall is active, checking rules for port 27017");

    // Check UFW rules
    const ufwRules = execCommand(
      'ufw status | grep 27017 2>/dev/null || echo "No UFW rules for 27017"'
    );
    if (!ufwRules.includes("No UFW rules")) {
      info("UFW rules for port 27017:");
      console.log(ufwRules);
    }

    // Check firewalld rules
    const firewalldRules = execCommand(
      'firewall-cmd --list-ports | grep 27017 2>/dev/null || echo "No firewalld rules for 27017"'
    );
    if (!firewalldRules.includes("No firewalld rules")) {
      info("Firewalld rules for port 27017:");
      console.log(firewalldRules);
    }

    warning(
      "If port 27017 is not allowed, you may need to open it in your firewall"
    );
  } else {
    info("No active firewall detected or unable to check firewall status");
  }
}

async function checkTraefikLogs() {
  header("Checking Traefik logs for MongoDB connections");

  // Get recent logs related to MongoDB or the agent ID
  const logs = execCommand(
    `docker logs traefik --tail 50 2>&1 | grep -E "mongodb|${AGENT_ID}" || echo "No relevant logs found"`
  );

  if (logs.includes("No relevant logs found")) {
    warning("No MongoDB-related logs found in Traefik");
  } else {
    info("Recent MongoDB-related logs from Traefik:");
    console.log(logs);
  }
}

// Main function
async function main() {
  console.log(
    `${colors.bold}Advanced MongoDB Connection Diagnostics${colors.reset}`
  );
  console.log("===========================================");

  const hostname = `${AGENT_ID}.${MONGO_DOMAIN}`;
  info(`Testing connection to: ${hostname}:${MONGO_PORT}`);

  // Step 1: Check DNS resolution
  const addresses = await checkDNS(hostname);

  // Step 2: Check Traefik configuration
  await checkTraefikConfig();

  // Step 3: Check firewall rules
  await checkFirewallRules();

  // Step 4: Test TCP connection to Traefik
  if (addresses && addresses.length > 0) {
    await testTcpConnection(addresses[0], MONGO_PORT, hostname);
  } else {
    warning("DNS resolution failed, trying localhost");
    await testTcpConnection("localhost", MONGO_PORT, "Traefik on localhost");
  }

  // Step 5: Test direct connection to MongoDB server if we have a target IP
  const targetIp = TARGET_IP || global.targetIp;
  if (targetIp) {
    await testDirectConnection(targetIp);
  }

  // Step 6: Check Traefik logs
  await checkTraefikLogs();

  // Step 7: Test MongoDB connection through Traefik
  await testTraefikConnection();

  // Summary and recommendations
  header("Recommendations");

  info("1. Ensure DNS is properly configured for your MongoDB domain");
  info("2. Verify TLS passthrough is enabled in all MongoDB routers");
  info("3. Check that port 27017 is correctly mapped in Traefik");
  info("4. Verify the target MongoDB server is accessible directly");
  info("5. Check firewall rules to ensure port 27017 is open");

  console.log("\nTo fix common issues:");
  console.log('1. Update docker-compose.yml to use "27017:27017" port mapping');
  console.log("2. Ensure dynamic.yml has proper TLS passthrough configuration");
  console.log("3. Restart Traefik with: docker restart traefik");
  console.log("4. Check your DNS configuration for *.mongodb.cloudlunacy.uk");
}

main().catch((err) => {
  console.error(`${colors.red}Fatal error: ${err.message}${colors.reset}`);
  process.exit(1);
});
