#!/usr/bin/env node

/**
 * This script initializes Traefik configuration in Consul
 * It ensures the proper structure is maintained to avoid middleware configuration errors
 */

const axios = require("axios");
const { promisify } = require("util");
const exec = promisify(require("child_process").exec);

// Configuration
const CONSUL_URL = "http://consul:8500";
const TRAEFIK_PREFIX = "traefik";

async function main() {
  try {
    console.log("Initializing Traefik configuration in Consul...");

    // Check if Consul is available
    try {
      await axios.get(`${CONSUL_URL}/v1/status/leader`);
      console.log("✅ Consul is available");
    } catch (error) {
      console.error("❌ Cannot connect to Consul:", error.message);
      process.exit(1);
    }

    // First, delete any existing Traefik configurations to start fresh
    try {
      await axios.delete(`${CONSUL_URL}/v1/kv/${TRAEFIK_PREFIX}?recurse=true`);
      console.log("✅ Cleared existing Traefik configuration");
    } catch (error) {
      console.warn("⚠️ Could not clear existing configuration:", error.message);
    }

    // Initialize the correct middleware configuration structure
    const middlewareConfig = {
      http: {
        middlewares: {
          "secure-headers": {
            headers: {
              frameDeny: true,
              browserXssFilter: true,
              contentTypeNosniff: true,
              forceSTSHeader: true,
              stsIncludeSubdomains: true,
              stsPreload: true,
              stsSeconds: 31536000,
            },
          },
          "cors-headers": {
            headers: {
              accessControlAllowMethods: [
                "GET",
                "POST",
                "PUT",
                "DELETE",
                "OPTIONS",
              ],
              accessControlAllowOriginList: [
                "https://*.cloudlunacy.uk",
                "https://*.apps.cloudlunacy.uk",
              ],
              accessControlAllowCredentials: true,
              accessControlMaxAge: 100,
              addVaryHeader: true,
            },
          },
          compress: {
            compress: {},
          },
        },
      },
    };

    // Convert to base64 as required by Consul KV API
    const middlewareConfigBase64 = Buffer.from(
      JSON.stringify(middlewareConfig)
    ).toString("base64");

    // Store in Consul with the correct key
    await axios.put(
      `${CONSUL_URL}/v1/kv/${TRAEFIK_PREFIX}/http`,
      middlewareConfigBase64
    );
    console.log("✅ Initialized middleware configuration in Consul");

    console.log("✅ Traefik configuration successfully initialized in Consul");
  } catch (error) {
    console.error(
      "❌ Error initializing Traefik configuration:",
      error.message
    );
    if (error.response) {
      console.error("Response details:", error.response.data);
    }
    process.exit(1);
  }
}

// Run the script
main();
