/**
 * frontdoorService.js
 *
 * A Node.js Express service for dynamically updating Traefik's dynamic configuration.
 * It exposes an API endpoint that lets you add new subdomain routing rules for MongoDB instances.
 *
 * The service reads and writes the YAML file (dynamic.yml) so that Traefik (with hot-reload enabled)
 * picks up new routes immediately.
 *
 * Author: [Your Name]
 * Date: [Current Date]
 */

"use strict";

// Load environment variables from .env file
require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const app = express();
app.use(express.json());

// Get configuration values from environment variables or set defaults
const PORT = process.env.FRONTDOOR_PORT || 3000;
const FRONTDOOR_API_TOKEN = process.env.FRONTDOOR_API_TOKEN || "CHANGEME";
// Path to the dynamic.yml file. Adjust if you mount this elsewhere.
const DYNAMIC_FILE = process.env.DYNAMIC_FILE_PATH || path.join(__dirname, "config", "dynamic.yml");

// ----------------------------------------------------------------------------
// Utility: Update Traefik's dynamic configuration file
// ----------------------------------------------------------------------------
function updateDynamicConfig(subdomain, targetIp) {
  let config = {};

  // Load existing YAML configuration if the file exists
  if (fs.existsSync(DYNAMIC_FILE)) {
    try {
      const fileContents = fs.readFileSync(DYNAMIC_FILE, "utf8");
      config = yaml.load(fileContents) || {};
    } catch (error) {
      throw new Error("Error parsing dynamic.yml: " + error.message);
    }
  }

  // Ensure the base structure exists
  config.tcp = config.tcp || {};
  config.tcp.routers = config.tcp.routers || {};
  config.tcp.services = config.tcp.services || {};

  // Generate safe names by replacing dots with dashes
  const safeName = subdomain.replace(/\./g, "-");
  const routerName = `${safeName}-router`;
  const serviceName = `${safeName}-service`;

  // Define the new router for the subdomain
  config.tcp.routers[routerName] = {
    entryPoints: ["mongodb"],
    rule: `HostSNI('${subdomain}')`,
    service: serviceName,
    tls: { passthrough: false }
  };

  // Define the new service to route to the target IP and port
  config.tcp.services[serviceName] = {
    loadBalancer: {
      servers: [
        {
          address: `${targetIp}:27017`
        }
      ]
    }
  };

  // Write the updated configuration back to the YAML file
  try {
    const newYaml = yaml.dump(config);
    fs.writeFileSync(DYNAMIC_FILE, newYaml, "utf8");
  } catch (error) {
    throw new Error("Error writing dynamic.yml: " + error.message);
  }
}

// ----------------------------------------------------------------------------
// API Endpoints
// ----------------------------------------------------------------------------

// Basic health check endpoint
app.get("/", (req, res) => {
  res.json({ message: "Front Door Service is running." });
});

// Protected endpoint to add a new subdomain route.
// Clients must send the correct Bearer token.
app.post("/api/frontdoor/add-subdomain", (req, res) => {
  // Validate API token from the Authorization header
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/, "");

  if (token !== FRONTDOOR_API_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { subdomain, targetIp } = req.body;
  if (!subdomain || !targetIp) {
    return res.status(400).json({ error: "Missing subdomain or targetIp" });
  }

  try {
    updateDynamicConfig(subdomain, targetIp);
    // With Traefik file provider hot-reload enabled, no restart is needed.
    console.log(`[INFO] Updated dynamic config: ${subdomain} -> ${targetIp}`);
    return res.json({ message: `Subdomain ${subdomain} added successfully.` });
  } catch (error) {
    console.error("[ERROR] Failed to update dynamic config:", error.message);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ----------------------------------------------------------------------------
// Start the Service
// ----------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[INFO] Front Door Service listening on port ${PORT}`);
});