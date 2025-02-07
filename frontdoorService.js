"use strict";

// Load environment variables from .env file
require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const app = express();
app.use(express.json());

// Configuration values (with defaults)
const PORT = process.env.FRONTDOOR_PORT || 3000;
const FRONTDOOR_API_TOKEN =
  process.env.FRONTDOOR_API_TOKEN || "your_secret_token";
// Path to the dynamic.yml file (ensure this matches your mounted volume)
const DYNAMIC_FILE =
  process.env.DYNAMIC_FILE_PATH ||
  path.join(__dirname, "config", "dynamic.yml");

/**
 * Updates Traefik's dynamic configuration file (dynamic.yml)
 * to add a new TCP router and service for a given subdomain and target IP.
 *
 * @param {string} subdomain - The subdomain to be routed (e.g., cl-xxxx.mongodb.cloudlunacy.uk)
 * @param {string} targetIp  - The IP address where MongoDB is accessible.
 */
function updateDynamicConfig(subdomain, targetIp) {
  let config = {};

  // Load existing YAML configuration if it exists
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

  // Define the new router to match the specific subdomain
  config.tcp.routers[routerName] = {
    entryPoints: ["mongodb"],
    rule: `HostSNI(\`${subdomain}\`)`,
    service: serviceName,
    tls: { passthrough: false },
  };

  // Define the new service to route to the target IP on MongoDB's default port (27017)
  config.tcp.services[serviceName] = {
    loadBalancer: {
      servers: [{ address: `${targetIp}:27017` }],
    },
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

// Health check endpoint
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
    console.log(`[INFO] Updated dynamic config: ${subdomain} -> ${targetIp}`);
    return res.json({ message: `Subdomain ${subdomain} added successfully.` });
  } catch (error) {
    console.error("[ERROR] Failed to update dynamic config:", error.message);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ----------------------------------------------------------------------------
// Start the Express Server
// ----------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[INFO] Front Door Service listening on port ${PORT}`);
});
