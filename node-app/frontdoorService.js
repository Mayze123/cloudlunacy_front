/**
 * frontdoorService.js
 * Express server to manage dynamic Traefik configuration.
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
 * Middleware for logging all requests
 */
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

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
 * Enhanced loadDynamicConfig function with better error handling and defaults
 */
async function loadDynamicConfig() {
  try {
    // First try to read the existing configuration
    const content = await fs.readFile(dynamicConfigPath, "utf8");

    if (!content || content.trim() === "") {
      // If file is empty, return default structure
      const defaultConfig = {
        http: { routers: {}, services: {}, middlewares: {} },
        tcp: { routers: {}, services: {} },
      };

      // Write this default structure to the file to ensure consistency
      await fs.writeFile(
        dynamicConfigPath,
        yaml.stringify(defaultConfig),
        "utf8"
      );
      console.log("Created default dynamic configuration structure");

      return defaultConfig;
    }

    try {
      // Parse the YAML content
      const config = yaml.parse(content);

      // Ensure the expected structure exists
      config.http = config.http || {
        routers: {},
        services: {},
        middlewares: {},
      };
      config.tcp = config.tcp || { routers: {}, services: {} };

      return config;
    } catch (parseError) {
      console.error("Error parsing dynamic config YAML:", parseError.message);

      // If parsing fails, backup the broken file and create a new one
      const backupPath = `${dynamicConfigPath}.broken.${Date.now()}`;
      await fs.copyFile(dynamicConfigPath, backupPath);
      console.warn(`Backed up broken config to ${backupPath}`);

      // Return and write default structure
      const defaultConfig = {
        http: { routers: {}, services: {}, middlewares: {} },
        tcp: { routers: {}, services: {} },
      };
      await fs.writeFile(
        dynamicConfigPath,
        yaml.stringify(defaultConfig),
        "utf8"
      );

      return defaultConfig;
    }
  } catch (err) {
    console.error("Error loading dynamic config:", err.message);

    // Create default config if file does not exist
    const defaultConfig = {
      http: { routers: {}, services: {}, middlewares: {} },
      tcp: { routers: {}, services: {} },
    };

    // Ensure the directory exists
    await fs.mkdir(path.dirname(dynamicConfigPath), { recursive: true });

    // Write the default config
    await fs.writeFile(
      dynamicConfigPath,
      yaml.stringify(defaultConfig),
      "utf8"
    );
    console.log(
      "Created new dynamic configuration file with default structure"
    );

    return defaultConfig;
  }
}

/**
 * Enhanced saveDynamicConfig function with file locking and validation
 */
async function saveDynamicConfig(config) {
  // Validate the configuration structure
  if (!config.http || !config.tcp) {
    throw new Error(
      "Invalid configuration structure: missing http or tcp sections"
    );
  }

  // Create a temporary file first
  const tempPath = `${dynamicConfigPath}.tmp.${Date.now()}`;

  try {
    // Convert to YAML
    const yamlStr = yaml.stringify(config);

    // Write to temp file first
    await fs.writeFile(tempPath, yamlStr, "utf8");

    // Move temp file to actual file (atomic operation)
    await fs.rename(tempPath, dynamicConfigPath);

    console.log("Dynamic configuration saved successfully");
    return true;
  } catch (err) {
    console.error("Error saving dynamic config:", err.message);

    // Clean up temp file if it exists
    try {
      await fs.unlink(tempPath);
    } catch (unlinkErr) {
      // Ignore error if file doesn't exist
    }

    throw err;
  }
}

/**
 * Trigger Traefik reload using the Docker API.
 */
async function triggerTraefikReload() {
  try {
    const container = docker.getContainer(
      process.env.TRAEFIK_CONTAINER || "traefik"
    );
    if (!container) throw new Error("Traefik container not found");
    await container.kill({ signal: "SIGHUP" });
    console.log("Traefik reload triggered successfully");
    return true;
  } catch (err) {
    console.error("Failed to trigger Traefik reload:", err.message);
    return false;
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
 * API status endpoint
 */
app.get("/api/status", (req, res) => {
  res.json({
    status: "ok",
    version: "1.0.0",
    config: {
      APP_DOMAIN,
      MONGO_DOMAIN,
    },
  });
});

/**
 * Endpoint for adding a MongoDB subdomain.
 */
app.post("/api/frontdoor/add-subdomain", jwtAuth, async (req, res) => {
  try {
    console.log("[DEBUG] Received add-subdomain request:", req.body);
    const { subdomain, targetIp } = req.body;

    if (!subdomain || !targetIp) {
      return res.status(400).json({
        error:
          "Missing required parameters: subdomain and targetIp are required",
        received: { subdomain, targetIp },
      });
    }

    if (!validateMongoInput(subdomain, targetIp)) {
      return res.status(400).json({
        error: "Invalid subdomain or target IP format.",
        validationDetails: {
          subdomain: {
            value: subdomain,
            valid: /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(subdomain),
            pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
          },
          targetIp: {
            value: targetIp,
            valid:
              /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(
                targetIp
              ),
            pattern:
              "^(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)(\\.(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)){3}$",
          },
        },
      });
    }

    // Load current dynamic configuration
    const config = await loadDynamicConfig();
    config.tcp = config.tcp || { routers: {}, services: {} };

    console.log(
      "[DEBUG] Setting up configuration for domain:",
      `${subdomain}.${MONGO_DOMAIN}`
    );

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
    const reloadTriggered = await triggerTraefikReload();

    res.json({
      success: true,
      message: "MongoDB subdomain added successfully.",
      details: {
        domain: `${subdomain}.${MONGO_DOMAIN}`,
        targetIp: targetIp,
        reloadTriggered,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Endpoint for adding an HTTP app subdomain.
 * This endpoint configures Traefik to route HTTP/HTTPS traffic.
 */
app.post("/api/frontdoor/add-app", jwtAuth, async (req, res) => {
  try {
    console.log("[DEBUG] Received add-app request:", req.body);
    console.log("[DEBUG] Headers:", req.headers);

    const { subdomain, targetUrl } = req.body;

    if (!subdomain || !targetUrl) {
      return res.status(400).json({
        error:
          "Missing required parameters: subdomain and targetUrl are required",
        received: { subdomain, targetUrl },
      });
    }

    if (!validateAppInput(subdomain, targetUrl)) {
      return res.status(400).json({
        error: "Invalid subdomain or target URL format.",
        validationDetails: {
          subdomain: {
            value: subdomain,
            valid: /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(subdomain),
            pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
          },
          targetUrl: {
            value: targetUrl,
            valid: /^https?:\/\/[a-zA-Z0-9.-]+(?::\d+)?(\/.*)?$/.test(
              targetUrl
            ),
            pattern: "^https?://[a-zA-Z0-9.-]+(?::\\d+)?(/.*)?$",
          },
        },
      });
    }

    // Load current dynamic configuration
    console.log(
      "[DEBUG] Loading dynamic configuration from:",
      dynamicConfigPath
    );
    let config;
    try {
      config = await loadDynamicConfig();
      console.log("[DEBUG] Current config loaded:", config);
    } catch (loadErr) {
      console.error("[ERROR] Failed to load dynamic config:", loadErr);
      config = {
        http: { routers: {}, services: {} },
        tcp: { routers: {}, services: {} },
      };
    }

    // Ensure http structure exists
    config.http = config.http || { routers: {}, services: {} };

    console.log(
      "[DEBUG] Setting up configuration for domain:",
      `${subdomain}.${APP_DOMAIN}`
    );

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

    console.log("[DEBUG] About to save dynamic configuration:", config);

    try {
      await saveDynamicConfig(config);
      console.log("[DEBUG] Dynamic configuration saved successfully");
    } catch (saveErr) {
      console.error("[ERROR] Failed to save dynamic config:", saveErr);
      return res.status(500).json({
        error: "Failed to save configuration",
        details: saveErr.message,
      });
    }

    // Try to trigger a reload, but continue even if it fails
    const reloadTriggered = await triggerTraefikReload();

    res.json({
      success: true,
      message: "App subdomain added successfully.",
      details: {
        domain: `${subdomain}.${APP_DOMAIN}`,
        targetUrl: targetUrl.startsWith("http")
          ? targetUrl
          : `http://${targetUrl}`,
        reloadTriggered,
      },
    });
  } catch (err) {
    console.error("[ERROR] Unexpected error in add-app endpoint:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Endpoint to retrieve current configuration
 */
app.get("/api/frontdoor/config", jwtAuth, async (req, res) => {
  try {
    const config = await loadDynamicConfig();
    res.json({ success: true, config });
  } catch (err) {
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
    if (!agentId) {
      return res.status(400).json({ error: "agentId is required" });
    }
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
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "30d" });
}

// Start the server.
app.listen(PORT, () => console.log(`Frontdoor API listening on port ${PORT}`));
