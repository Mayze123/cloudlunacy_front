#!/usr/bin/env node

/**
 * Initialize Traefik-Consul Integration
 *
 * This script initializes the Consul KV store with the proper structure
 * for Traefik to read configuration correctly.
 */

require("dotenv").config();
const Consul = require("consul");
const { promisify } = require("util");
const sleep = promisify(setTimeout);

// Configuration
const CONSUL_HOST = process.env.CONSUL_HOST || "consul";
const CONSUL_PORT = process.env.CONSUL_PORT || 8500;
const CONSUL_PREFIX = "traefik";

// Initialize consul client
const consul = new Consul({
  host: CONSUL_HOST,
  port: CONSUL_PORT,
  promisify: true,
});

// Main function
async function main() {
  console.log("=== Initializing Traefik-Consul Integration ===");

  try {
    // 1. Check Consul connection
    console.log("\n1. Checking Consul connection...");
    await checkConsulConnection();
    console.log("✓ Consul connection successful");

    // 2. Initialize key structure
    console.log("\n2. Initializing Consul key structure...");
    await initializeKeyStructure();
    console.log("✓ Consul key structure initialized");

    // 3. Add default entrypoints
    console.log("\n3. Adding default entrypoints...");
    await addDefaultEntrypoints();
    console.log("✓ Default entrypoints added");

    // 4. Add default providers
    console.log("\n4. Adding default providers configuration...");
    await addDefaultProviders();
    console.log("✓ Default providers added");

    console.log("\n=== Initialization Completed Successfully ===");
    console.log("The Consul KV store is now properly initialized for Traefik!");
  } catch (error) {
    console.error("\n❌ Initialization Failed!");
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

// Initialize key structure
async function initializeKeyStructure() {
  try {
    // Base key structure
    const baseStructure = {
      http: {
        routers: {},
        services: {},
        middlewares: {},
      },
      tcp: {
        routers: {},
        services: {},
      },
      tls: {
        certificates: {},
        options: {
          default: {
            minVersion: "VersionTLS12",
            sniStrict: true,
          },
        },
      },
      entrypoints: {},
    };

    // Create or update each section in the structure
    for (const [section, data] of Object.entries(baseStructure)) {
      await createOrUpdateKey(`${CONSUL_PREFIX}/${section}`, data);
      console.log(`- Created/updated ${section} section`);
    }
  } catch (error) {
    throw new Error(`Failed to initialize key structure: ${error.message}`);
  }
}

// Add default entrypoints
async function addDefaultEntrypoints() {
  try {
    const entrypoints = {
      web: {
        address: ":80",
        http: {
          redirections: {
            entryPoint: {
              to: "websecure",
              scheme: "https",
            },
          },
        },
      },
      websecure: {
        address: ":443",
      },
      mongodb: {
        address: ":27017",
      },
      traefik: {
        address: ":8081",
      },
    };

    await createOrUpdateKey(`${CONSUL_PREFIX}/entrypoints`, entrypoints);
    console.log("- Added default entrypoints configuration");
  } catch (error) {
    throw new Error(`Failed to add default entrypoints: ${error.message}`);
  }
}

// Add default providers
async function addDefaultProviders() {
  try {
    const providers = {
      consulcatalog: {
        prefix: CONSUL_PREFIX,
        exposedByDefault: false,
      },
      docker: {
        endpoint: "unix:///var/run/docker.sock",
        exposedByDefault: false,
        watch: true,
      },
      file: {
        directory: "/etc/traefik/dynamic",
        watch: true,
      },
    };

    await createOrUpdateKey(`${CONSUL_PREFIX}/providers`, providers);
    console.log("- Added default providers configuration");
  } catch (error) {
    throw new Error(`Failed to add default providers: ${error.message}`);
  }
}

// Helper function to create or update a key
async function createOrUpdateKey(key, value) {
  try {
    const valueStr = JSON.stringify(value);
    await consul.kv.set(key, valueStr);
  } catch (error) {
    throw new Error(`Failed to set key ${key}: ${error.message}`);
  }
}

// Run the main function
main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
