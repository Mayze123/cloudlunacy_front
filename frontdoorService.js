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
 * Update Traefik's dynamic configuration file with a new subdomain routing rule.
 * @param {string} subdomain - The subdomain to be added.
 * @param {string} targetIp - The target IP address of the MongoDB instance.
 */
function updateDynamicConfig(subdomain, targetIp) {
  let config = {};

  if (fs.existsSync(DYNAMIC_FILE)) {
    try {
      const fileContents = fs.readFileSync(DYNAMIC_FILE, "utf8");
      config = yaml.load(fileContents) || {};
    } catch (error) {
      throw new Error("Error parsing dynamic.yml: " + error.message);
    }
  }

  config.tcp = config.tcp || {};
  config.tcp.routers = config.tcp.routers || {};
  config.tcp.services = config.tcp.services || {};

  // Generate safe names by replacing dots with dashes
  const safeName = subdomain.replace(/\./g, "-");
  const routerName = `${safeName}-router`;
  const serviceName = `${safeName}-service`;

  // Define the router with SNI rule matching the subdomain
  config.tcp.routers[routerName] = {
    entryPoints: ["mongodb"],
    rule: `HostSNI(\`${subdomain}\`)`,
    service: serviceName,
    tls: { passthrough: false },
  };

  // Define the service to route to the target IP and port 27017
  config.tcp.services[serviceName] = {
    loadBalancer: {
      servers: [{ address: `${targetIp}:27017` }],
    },
  };

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
