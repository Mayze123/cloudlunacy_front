/**
 * frontdoorService.js
 * Basic Express server to manage dynamic Traefik configuration.
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
const express = require("express");
const jwt = require("jsonwebtoken");
const Docker = require("dockerode");
const yaml = require("yaml");

const app = express();
const PORT = process.env.NODE_PORT || 3005;
const JWT_SECRET = process.env.JWT_SECRET;
const dynamicConfigPath =
  process.env.DYNAMIC_CONFIG_PATH ||
  path.join(__dirname, "../config/dynamic.yml");
const docker = new Docker({ socketPath: "/var/run/docker.sock" });

// Ensure required environment variables are available
const APP_DOMAIN = process.env.APP_DOMAIN || "apps.cloudlunacy.uk";
const MONGO_DOMAIN = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";

// Log environment variables at startup for debugging
console.log("Environment variables:");
console.log("NODE_PORT:", process.env.NODE_PORT);
console.log("JWT_SECRET:", process.env.JWT_SECRET ? "Set (hidden)" : "Not set");
console.log("APP_DOMAIN:", APP_DOMAIN);
console.log("MONGO_DOMAIN:", MONGO_DOMAIN);
console.log("DYNAMIC_CONFIG_PATH:", dynamicConfigPath);

app.use(express.json());

/**
 * JWT authentication middleware.
 */
function jwtAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader)
    return res.status(401).json({ error: "Missing Authorization header" });
  const token = authHeader.split(" ")[1];
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(403).json({ error: "Invalid token" });
  }
}

/**
 * Load dynamic configuration from dynamic.yml.
 */
async function loadDynamicConfig() {
  try {
    const content = await fs.readFile(dynamicConfigPath, "utf8");
    return content ? yaml.parse(content) : {};
  } catch (err) {
    return {};
  }
}

/**
 * Save dynamic configuration to dynamic.yml.
 */
async function saveDynamicConfig(config) {
  const yamlStr = yaml.stringify(config);
  await fs.writeFile(dynamicConfigPath, yamlStr, "utf8");
}

/**
 * (Optional) Trigger Traefik reload using the Docker API.
 */
async function triggerTraefikReload() {
  try {
    const container = docker.getContainer(
      process.env.TRAEFIK_CONTAINER || "traefik"
    );
    if (!container) throw new Error("Traefik container not found");
    await container.kill({ signal: "SIGHUP" });
  } catch (err) {
    throw new Error(`Failed to trigger Traefik reload: ${err.message}`);
  }
}

/**
 * Validate subdomain and target IP/URL for MongoDB deployments.
 */
function validateMongoInput(subdomain, targetIp) {
  const subdomainRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const ipRegex =
    /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
  return subdomainRegex.test(subdomain) && ipRegex.test(targetIp);
}

/**
 * Validate subdomain and target URL for HTTP app deployments.
 */
function validateAppInput(subdomain, targetUrl) {
  const subdomainRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  // Simple URL validation (must start with http:// or https://)
  const urlRegex = /^https?:\/\/[a-zA-Z0-9.-]+(?::\d+)?(\/.*)?$/;
  return subdomainRegex.test(subdomain) && urlRegex.test(targetUrl);
}

/**
 * Endpoint for adding a MongoDB subdomain.
 */
app.post("/api/frontdoor/add-subdomain", jwtAuth, async (req, res) => {
  try {
    const { subdomain, targetIp } = req.body;
    if (!validateMongoInput(subdomain, targetIp)) {
      return res
        .status(400)
        .json({ error: "Invalid subdomain or target IP format." });
    }

    // Load current dynamic configuration
    const config = await loadDynamicConfig();
    config.tcp = config.tcp || { routers: {}, services: {} };
    config.tcp.routers[subdomain] = {
      rule: `HostSNI(\`${subdomain}.${MONGO_DOMAIN}\`)`,
      service: `${subdomain}-service`,
    };
    config.tcp.services[`${subdomain}-service`] = {
      loadBalancer: {
        servers: [{ address: `${targetIp}:27017` }],
      },
    };

    await saveDynamicConfig(config);
    // Optionally trigger a Traefik reload:
    // await triggerTraefikReload();

    res.json({
      success: true,
      message: "MongoDB subdomain added successfully.",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * New Endpoint for adding an HTTP app subdomain.
 * This endpoint configures Traefik to route HTTP/HTTPS traffic.
 */
app.post("/api/frontdoor/add-app", jwtAuth, async (req, res) => {
  try {
    console.log("[DEBUG] Received add-app request:", req.body);
    const { subdomain, targetUrl } = req.body;
    if (!validateAppInput(subdomain, targetUrl)) {
      return res
        .status(400)
        .json({ error: "Invalid subdomain or target URL format." });
    }

    // Load current dynamic configuration
    const config = await loadDynamicConfig();
    config.http = config.http || { routers: {}, services: {} };

    console.log(
      "[DEBUG] Current dynamic configuration:",
      JSON.stringify(config, null, 2)
    );

    console.log("🚀 ~ app.post ~ APP_DOMAIN:", APP_DOMAIN);

    // Create an HTTP router for the subdomain
    config.http.routers[subdomain] = {
      rule: `Host(\`${subdomain}.${APP_DOMAIN}\`)`,
      service: `${subdomain}-service`,
      entryPoints: ["web", "websecure"],
      tls: {
        certResolver: "letsencrypt",
      },
    };

    // Create the service definition
    config.http.services[`${subdomain}-service`] = {
      loadBalancer: {
        servers: [
          {
            url: targetUrl.startsWith("http")
              ? targetUrl
              : `http://${targetUrl}`,
          },
        ],
      },
    };

    await saveDynamicConfig(config);
    console.log(
      "[DEBUG] Updated dynamic configuration:",
      JSON.stringify(config, null, 2)
    );

    // Optionally trigger a Traefik reload:
    // await triggerTraefikReload();

    res.json({ success: true, message: "App subdomain added successfully." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Healthcheck endpoint.
 */
app.get("/health", (req, res) => res.json({ status: "ok" }));

/**
 * Endpoint for agent registration.
 */
app.post("/api/agent/register", async (req, res) => {
  try {
    const { agentId } = req.body;
    const token = generateAgentToken({ agentId });
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Generate JWT for an agent.
 */
function generateAgentToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "24h" });
}

// Start the server.
app.listen(PORT, () => console.log(`Frontdoor API listening on port ${PORT}`));
