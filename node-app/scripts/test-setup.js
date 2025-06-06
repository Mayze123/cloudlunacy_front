/**
 * Test script to verify the development environment setup
 */

const axios = require("axios");
const { MongoClient } = require("mongodb");
const { execSync } = require("child_process");

// Configuration
const config = {
  nodeApp: "http://localhost:3005",
  haproxy: "http://localhost:8081",
  mongodb: {
    url: "mongodb://admin:password@test.mongodb.cloudlunacy.uk:27018",
    adminDb: "admin",
  },
};

// Test Node.js API
async function testNodeApi() {
  console.log("Testing Node.js API...");
  try {
    const response = await axios.get(`${config.nodeApp}/health`);
    console.log("✅ Node.js API is running");
    console.log(`   Status: ${response.data.status}`);
    return true;
  } catch (error) {
    console.error("❌ Node.js API test failed:", error.message);
    return false;
  }
}

// Test HAProxy Dashboard
async function testHAProxyDashboard() {
  console.log("Testing HAProxy Dashboard...");
  try {
    const _response = await axios.get(`${config.haproxy}/stats`);
    console.log("✅ HAProxy Dashboard is running");
    return true;
  } catch (error) {
    console.error("❌ HAProxy Dashboard test failed:", error.message);
    return false;
  }
}

// Test MongoDB Connection
async function testMongoDBConnection() {
  console.log("Testing MongoDB Connection...");

  // In development without MongoDB, skip actual connection
  if (process.env.SKIP_MONGO_TEST === "true") {
    console.log("⚠️ MongoDB test skipped (SKIP_MONGO_TEST=true)");
    return true;
  }

  let client;
  try {
    client = new MongoClient(config.mongodb.url);
    await client.connect();
    const adminDb = client.db(config.mongodb.adminDb);
    const result = await adminDb.command({ ping: 1 });
    console.log("✅ MongoDB Connection successful");
    console.log(`   Ping result: ${JSON.stringify(result)}`);
    return true;
  } catch (error) {
    console.error("❌ MongoDB Connection test failed:", error.message);
    return false;
  } finally {
    if (client) await client.close();
  }
}

// Test Docker Networks
function testDockerNetworks() {
  console.log("Testing Docker Networks...");
  try {
    const networks = execSync("docker network ls").toString();
    const hasHaproxyNetwork = networks.includes("haproxy-network");
    const hasCloudlunacyNetwork = networks.includes("cloudlunacy-network");

    if (hasHaproxyNetwork && hasCloudlunacyNetwork) {
      console.log("✅ Docker networks are properly configured");
      return true;
    } else {
      console.error("❌ Docker networks test failed:");
      if (!hasHaproxyNetwork) console.error("   haproxy-network not found");
      if (!hasCloudlunacyNetwork)
        console.error("   cloudlunacy-network not found");
      return false;
    }
  } catch (error) {
    console.error("❌ Docker networks test failed:", error.message);
    return false;
  }
}

// Run all tests
async function runTests() {
  console.log("=== CloudLunacy Development Environment Test ===\n");

  const results = {
    nodeApi: await testNodeApi(),
    haproxyDashboard: await testHAProxyDashboard(),
    mongoDBConnection: await testMongoDBConnection(),
    dockerNetworks: testDockerNetworks(),
  };

  console.log("\n=== Test Results Summary ===");
  Object.entries(results).forEach(([test, passed]) => {
    console.log(
      `${passed ? "✅" : "❌"} ${test}: ${passed ? "PASSED" : "FAILED"}`
    );
  });

  const allPassed = Object.values(results).every((result) => result);
  console.log(
    `\nOverall: ${allPassed ? "✅ ALL TESTS PASSED" : "❌ SOME TESTS FAILED"}`
  );

  if (!allPassed) {
    console.log("\nTroubleshooting tips:");
    console.log("1. Check if all containers are running: docker ps");
    console.log("2. Check container logs: docker logs haproxy-dev");
    console.log("3. Verify host entries in /etc/hosts");
    console.log(
      "4. Try restarting the development environment: ./start-dev.sh"
    );
  }
}

// Run the tests
runTests().catch(console.error);
