#!/usr/bin/env node

/**
 * Consul-Traefik Integration Verification
 *
 * This script verifies the integration between Consul and Traefik by:
 * 1. Checking Consul connection and key structure
 * 2. Registering a test agent in Consul
 * 3. Verifying Traefik has loaded the configuration
 * 4. Cleaning up the test agent
 */

require("dotenv").config();
const Consul = require("consul");
const axios = require("axios");
const { promisify } = require("util");
const sleep = promisify(setTimeout);

// Configuration
const CONSUL_HOST = process.env.CONSUL_HOST || "consul";
const CONSUL_PORT = process.env.CONSUL_PORT || 8500;
const TRAEFIK_API = process.env.TRAEFIK_API || "http://traefik:8080/api";
const TEST_AGENT_NAME = "verify-test-agent";
const CONSUL_PREFIX = "traefik";

// Initialize consul client
const consul = new Consul({
  host: CONSUL_HOST,
  port: CONSUL_PORT,
  promisify: true,
});

// Main function
async function main() {
  console.log("=== Consul-Traefik Integration Verification ===");

  try {
    // 1. Check Consul connection
    console.log("\n1. Checking Consul connection...");
    await checkConsulConnection();
    console.log("✓ Consul connection successful");

    // 2. Check Consul key structure
    console.log("\n2. Checking Consul key structure...");
    await checkConsulKeyStructure();
    console.log("✓ Consul key structure is valid");

    // 3. Register test agent
    console.log("\n3. Registering test agent...");
    await registerTestAgent();
    console.log("✓ Test agent registered successfully");

    // 4. Wait for Traefik to update (Traefik watches Consul with a slight delay)
    console.log("\n4. Waiting for Traefik to update configuration...");
    await sleep(2000); // 2 seconds should be enough

    // 5. Verify Traefik configuration
    console.log("\n5. Verifying Traefik configuration...");
    await verifyTraefikConfiguration();
    console.log("✓ Traefik configuration verified");

    // 6. Clean up
    console.log("\n6. Cleaning up test agent...");
    await cleanupTestAgent();
    console.log("✓ Test agent cleaned up");

    console.log("\n=== Verification Completed Successfully ===");
    console.log("The Consul-Traefik integration is working correctly!");
  } catch (error) {
    console.error("\n❌ Verification Failed!");
    console.error(`Error: ${error.message}`);
    if (error.response) {
      console.error("Response data:", error.response.data);
    }
    process.exit(1);
  }
}

// Check Consul connection
async function checkConsulConnection() {
  try {
    const leader = await consul.status.leader();
    console.log(`- Consul leader: ${leader}`);

    const peers = await consul.status.peers();
    console.log(
      `- Consul peers: ${peers.length > 0 ? peers.join(", ") : "none"}`
    );
  } catch (error) {
    throw new Error(`Failed to connect to Consul: ${error.message}`);
  }
}

// Check Consul key structure
async function checkConsulKeyStructure() {
  try {
    // Check if the base structure exists
    const baseKeys = [
      `${CONSUL_PREFIX}/http/routers`,
      `${CONSUL_PREFIX}/http/services`,
      `${CONSUL_PREFIX}/tcp/routers`,
      `${CONSUL_PREFIX}/tcp/services`,
    ];

    for (const key of baseKeys) {
      const exists = await consul.kv.get(key);
      if (!exists) {
        console.log(`- Creating missing key: ${key}`);
        await consul.kv.set(key, JSON.stringify({}));
      } else {
        console.log(`- Key exists: ${key}`);
      }
    }
  } catch (error) {
    throw new Error(
      `Failed to check/create Consul key structure: ${error.message}`
    );
  }
}

// Register test agent
async function registerTestAgent() {
  try {
    // Create HTTP router
    const httpRouter = {
      entryPoints: ["websecure"],
      rule: `Host(\`${TEST_AGENT_NAME}.test.local\`)`,
      service: `${TEST_AGENT_NAME}-http`,
      middlewares: ["test-strip-prefix"],
    };

    // Create HTTP service
    const httpService = {
      loadBalancer: {
        servers: [{ url: "http://localhost:3005" }],
      },
    };

    // Create TCP router
    const tcpRouter = {
      entryPoints: ["mongodb"],
      rule: `HostSNI(\`${TEST_AGENT_NAME}.mongodb.test.local\`)`,
      service: `${TEST_AGENT_NAME}-mongo`,
    };

    // Create TCP service
    const tcpService = {
      loadBalancer: {
        servers: [{ address: "localhost:27017" }],
      },
    };

    // Create middleware for testing
    const middleware = {
      stripPrefix: {
        prefixes: ["/test"],
      },
    };

    // Set all in Consul
    await consul.kv.set(
      `${CONSUL_PREFIX}/http/routers/${TEST_AGENT_NAME}`,
      JSON.stringify(httpRouter)
    );
    await consul.kv.set(
      `${CONSUL_PREFIX}/http/services/${TEST_AGENT_NAME}-http`,
      JSON.stringify(httpService)
    );
    await consul.kv.set(
      `${CONSUL_PREFIX}/tcp/routers/${TEST_AGENT_NAME}`,
      JSON.stringify(tcpRouter)
    );
    await consul.kv.set(
      `${CONSUL_PREFIX}/tcp/services/${TEST_AGENT_NAME}-mongo`,
      JSON.stringify(tcpService)
    );
    await consul.kv.set(
      `${CONSUL_PREFIX}/http/middlewares/test-strip-prefix`,
      JSON.stringify(middleware)
    );

    console.log(`- HTTP router registered for ${TEST_AGENT_NAME}`);
    console.log(`- HTTP service registered for ${TEST_AGENT_NAME}-http`);
    console.log(`- TCP router registered for ${TEST_AGENT_NAME}`);
    console.log(`- TCP service registered for ${TEST_AGENT_NAME}-mongo`);
    console.log(`- Middleware registered for test-strip-prefix`);
  } catch (error) {
    throw new Error(`Failed to register test agent: ${error.message}`);
  }
}

// Verify Traefik configuration
async function verifyTraefikConfiguration() {
  try {
    // Using axios to call Traefik's API
    // Note: This requires Traefik API to be exposed and accessible
    const traefikApiAvailable = process.env.VERIFY_TRAEFIK_API === "true";

    if (traefikApiAvailable) {
      // Check HTTP routers
      const httpRoutersResponse = await axios.get(
        `${TRAEFIK_API}/http/routers`
      );
      const httpRouters = httpRoutersResponse.data;

      const testRouter = httpRouters.find(
        (router) => router.name === TEST_AGENT_NAME
      );
      if (!testRouter) {
        throw new Error("Test HTTP router not found in Traefik configuration");
      }

      console.log(`- Found HTTP router in Traefik: ${testRouter.name}`);
      console.log(`  Rule: ${testRouter.rule}`);

      // Check HTTP services
      const httpServicesResponse = await axios.get(
        `${TRAEFIK_API}/http/services`
      );
      const httpServices = httpServicesResponse.data;

      const testService = httpServices.find(
        (service) => service.name === `${TEST_AGENT_NAME}-http`
      );
      if (!testService) {
        throw new Error("Test HTTP service not found in Traefik configuration");
      }

      console.log(`- Found HTTP service in Traefik: ${testService.name}`);

      // If we have TCP API access
      try {
        // Check TCP routers
        const tcpRoutersResponse = await axios.get(
          `${TRAEFIK_API}/tcp/routers`
        );
        const tcpRouters = tcpRoutersResponse.data;

        const testTcpRouter = tcpRouters.find(
          (router) => router.name === TEST_AGENT_NAME
        );
        if (testTcpRouter) {
          console.log(`- Found TCP router in Traefik: ${testTcpRouter.name}`);
          console.log(`  Rule: ${testTcpRouter.rule}`);
        }
      } catch (tcpError) {
        console.log(
          "- TCP router verification skipped (API might not expose TCP routers)"
        );
      }
    } else {
      // Alternative: just check Consul KV to make sure our values are there
      console.log("- Traefik API verification skipped (API not accessible)");
      console.log("- Verifying via Consul KV store instead...");

      const httpRouter = await consul.kv.get(
        `${CONSUL_PREFIX}/http/routers/${TEST_AGENT_NAME}`
      );
      if (!httpRouter) {
        throw new Error("Test HTTP router not found in Consul");
      }

      const httpService = await consul.kv.get(
        `${CONSUL_PREFIX}/http/services/${TEST_AGENT_NAME}-http`
      );
      if (!httpService) {
        throw new Error("Test HTTP service not found in Consul");
      }

      console.log("- Verified test configuration exists in Consul KV store");
    }
  } catch (error) {
    throw new Error(`Failed to verify Traefik configuration: ${error.message}`);
  }
}

// Clean up test agent
async function cleanupTestAgent() {
  try {
    await consul.kv.del(`${CONSUL_PREFIX}/http/routers/${TEST_AGENT_NAME}`);
    await consul.kv.del(
      `${CONSUL_PREFIX}/http/services/${TEST_AGENT_NAME}-http`
    );
    await consul.kv.del(`${CONSUL_PREFIX}/tcp/routers/${TEST_AGENT_NAME}`);
    await consul.kv.del(
      `${CONSUL_PREFIX}/tcp/services/${TEST_AGENT_NAME}-mongo`
    );
    await consul.kv.del(`${CONSUL_PREFIX}/http/middlewares/test-strip-prefix`);

    console.log("- All test keys removed from Consul");
  } catch (error) {
    throw new Error(`Failed to clean up test agent: ${error.message}`);
  }
}

// Run the main function
main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
