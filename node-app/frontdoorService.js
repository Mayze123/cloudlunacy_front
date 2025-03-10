/**
 * frontdoorService.js
 * Express server to manage dynamic Traefik configuration.
 * This version includes proper logging.
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
const express = require("express");
const morgan = require("morgan");
const jwt = require("jsonwebtoken");
const Docker = require("dockerode");
const yaml = require("yaml");
const logger = require("./utils/logger").getLogger("frontdoor");
const configManager = require("./utils/configManager");

const app = express();
const PORT = process.env.NODE_PORT || 3005;
const JWT_SECRET = process.env.JWT_SECRET;
const dynamicConfigPath =
  process.env.DYNAMIC_CONFIG_PATH || path.join(__dirname, "config/dynamic.yml");
const docker = new Docker({ socketPath: "/var/run/docker.sock" });

// Ensure required environment variables are available
const APP_DOMAIN = process.env.APP_DOMAIN || "apps.cloudlunacy.uk";
const MONGO_DOMAIN = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
const SHARED_NETWORK = process.env.SHARED_NETWORK || "cloudlunacy-network";

// Log environment variables at startup for debugging
logger.info("Starting frontdoor service with configuration:", {
  NODE_PORT: process.env.NODE_PORT,
  JWT_SECRET: process.env.JWT_SECRET ? "Set (hidden)" : "Not set",
  APP_DOMAIN,
  MONGO_DOMAIN,
  DYNAMIC_CONFIG_PATH: dynamicConfigPath,
  SHARED_NETWORK,
});

/**
 * Initialize the configuration file with proper structure
 */
async function initializeConfigFile() {
  try {
    logger.info("Checking dynamic config file...");

    // Check if the directory exists, if not create it
    const configDir = path.dirname(dynamicConfigPath);
    try {
      await fs.access(configDir);
      logger.debug(`Config directory exists at ${configDir}`);
    } catch (dirErr) {
      logger.info(`Creating directory: ${configDir}`);
      await fs.mkdir(configDir, { recursive: true });
    }

    // Check if the file exists
    try {
      await fs.access(dynamicConfigPath);
      logger.info("Dynamic config file exists");

      // Check if it has the correct structure
      const content = await fs.readFile(dynamicConfigPath, "utf8");
      let config;

      try {
        config = yaml.parse(content) || {};
        logger.debug("Successfully parsed existing config file");
      } catch (parseErr) {
        logger.error("Error parsing existing config file:", {
          error: parseErr.message,
        });

        logger.info("Creating backup of corrupted file and creating new one");

        // Backup the corrupted file
        const backupPath = `${dynamicConfigPath}.corrupted.${Date.now()}`;
        await fs.copyFile(dynamicConfigPath, backupPath);
        logger.info(`Backup created at ${backupPath}`);

        // Create a new config with proper structure
        config = {
          http: { routers: {}, services: {}, middlewares: {} },
        };
      }

      await checkMongoDBConnectivity().catch((error) => {
        logger.warn("MongoDB connectivity check failed:", {
          error: error.message,
        });
      });

      let needsUpdate = false;

      // Make sure required sections exist
      if (!config.http) {
        config.http = { routers: {}, services: {}, middlewares: {} };
        needsUpdate = true;
        logger.info("Adding missing http section to config");
      }

      if (needsUpdate) {
        logger.info("Updating dynamic config file with proper structure");
        const yamlStr = yaml.stringify(config, { indent: 2 });
        await fs.writeFile(dynamicConfigPath, yamlStr, "utf8");
      }
    } catch (accessErr) {
      // File doesn't exist, create it
      logger.info("Creating dynamic config file with initial structure");
      const initialConfig = {
        http: {
          routers: {},
          services: {},
          middlewares: {
            pingMiddleware: { ping: {} },
            "web-to-websecure": {
              redirectScheme: {
                scheme: "https",
                permanent: true,
              },
            },
          },
        },
      };

      const yamlStr = yaml.stringify(initialConfig, { indent: 2 });
      await fs.writeFile(dynamicConfigPath, yamlStr, "utf8");
    }

    // Verify file permissions
    try {
      // Try to create a temporary file in the same directory
      const configDir = path.dirname(dynamicConfigPath);
      const testFilePath = path.join(configDir, "test-write.tmp");
      await fs.writeFile(testFilePath, "test", "utf8");
      await fs.unlink(testFilePath);
      logger.info("Write permissions verified for config directory");
    } catch (permErr) {
      logger.error("No write permissions to config directory:", {
        error: permErr.message,
        path: path.dirname(dynamicConfigPath),
      });
      logger.warn("Node app may not be able to update dynamic configuration!");
    }

    logger.info("Dynamic config file initialized successfully");
  } catch (err) {
    logger.error("Failed to initialize dynamic config file:", {
      error: err.message,
      stack: err.stack,
    });
  }
}

// HTTP request logging middleware
app.use(morgan("combined", { stream: require("./utils/logger").stream }));

// Initialize the config manager
app.on("ready", async () => {
  try {
    await configManager.initialize();
    logger.info("Configuration manager initialized successfully");
  } catch (err) {
    logger.error("Failed to initialize configuration manager:", {
      error: err.message,
      stack: err.stack,
    });
  }
});

// Call initialization function at startup
initializeConfigFile().catch((err) => {
  logger.error("Initialization error:", {
    error: err.message,
    stack: err.stack,
  });
});

app.use(express.json());

/**
 * JWT authentication middleware.
 */
function jwtAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    logger.warn("Authentication failed: Missing Authorization header", {
      ip: req.ip,
      path: req.path,
    });
    return res.status(401).json({ error: "Missing Authorization header" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Add decoded token to request for use in route handlers
    req.user = decoded;

    logger.debug("Authentication successful", {
      user: decoded,
      path: req.path,
    });

    next();
  } catch (err) {
    logger.warn("Authentication failed: Invalid token", {
      ip: req.ip,
      path: req.path,
      error: err.message,
    });
    return res.status(403).json({ error: "Invalid token" });
  }
}

/**
 * Load dynamic configuration from dynamic.yml.
 */
async function loadDynamicConfig() {
  try {
    logger.debug("Loading dynamic configuration");
    const content = await fs.readFile(dynamicConfigPath, "utf8");
    let config = yaml.parse(content) || {};

    // Remove root-level invalid keys
    delete config.routers;
    delete config.services;
    delete config.tls;

    // Ensure proper structure
    config.http = config.http || { routers: {}, services: {}, middlewares: {} };

    // Clean nested sections
    config.http.routers = config.http.routers || {};
    config.http.services = config.http.services || {};
    config.http.middlewares = config.http.middlewares || {};

    logger.debug("Dynamic configuration loaded successfully", {
      routersCount: Object.keys(config.http.routers).length,
      servicesCount: Object.keys(config.http.services).length,
    });

    return config;
  } catch (err) {
    logger.error("Failed to load dynamic configuration:", {
      error: err.message,
      path: dynamicConfigPath,
    });

    // Return a valid empty configuration
    return {
      http: { routers: {}, services: {}, middlewares: {} },
    };
  }
}

/**
 * MongoDB accessibility check:
 * Add this function to test MongoDB connectivity through Docker networking
 */
async function checkMongoDBConnectivity() {
  try {
    logger.info("Checking MongoDB connectivity via Docker network...");

    // Use a simple socket connection check rather than HTTP
    const net = require("net");

    return new Promise((resolve) => {
      const socket = net.createConnection({
        host: "mongodb-agent", // Container name on the Docker network
        port: 27017,
      });

      // Set a timeout
      socket.setTimeout(2000);

      socket.on("connect", () => {
        logger.info("MongoDB container is accessible through Docker network");
        socket.end();
        resolve(true);
      });

      socket.on("timeout", () => {
        logger.warn("MongoDB connectivity test timed out");
        socket.destroy();
        resolve(false);
      });

      socket.on("error", (err) => {
        logger.warn("MongoDB connectivity test failed:", {
          error: err.message,
        });
        resolve(false);
      });
    });
  } catch (err) {
    logger.warn("MongoDB connectivity test failed:", { error: err.message });
    logger.info("This is normal if MongoDB is not yet running");
    return false;
  }
}

/**
 * Save dynamic configuration to dynamic.yml.
 * This function has been fixed to ensure proper YAML indentation and structure.
 */
async function saveDynamicConfig(config) {
  // Always include the HTTP section with proper structure
  const sanitizedConfig = {
    http: {
      routers: config.http.routers || {},
      services: config.http.services || {},
      middlewares: config.http.middlewares || {},
    },
  };

  // Only include TCP if there is any content
  if (
    config.tcp &&
    (Object.keys(config.tcp.routers || {}).length > 0 ||
      Object.keys(config.tcp.services || {}).length > 0)
  ) {
    sanitizedConfig.tcp = {
      routers: config.tcp.routers || {},
      services: config.tcp.services || {},
    };
  }

  // Ensure we use proper indentation (2 spaces) and disable alias duplication
  const yamlStr = yaml.stringify(sanitizedConfig, {
    indent: 2,
    aliasDuplicateObjects: false,
  });

  try {
    await fs.writeFile(dynamicConfigPath, yamlStr, "utf8");
    logger.info(`Successfully wrote configuration to ${dynamicConfigPath}`, {
      bytesWritten: yamlStr.length,
      routersCount: Object.keys(sanitizedConfig.http.routers).length,
    });

    // Validate the YAML after writing (optional, for debugging)
    try {
      const writtenContent = await fs.readFile(dynamicConfigPath, "utf8");
      const parsedContent = yaml.parse(writtenContent);
      logger.debug("YAML validation successful");
    } catch (validateErr) {
      logger.error("Written YAML failed validation:", {
        error: validateErr.message,
      });
    }
  } catch (writeErr) {
    logger.error(`Failed to write to ${dynamicConfigPath}:`, {
      error: writeErr.message,
      stack: writeErr.stack,
    });
    throw writeErr;
  }
}

/**
 * Trigger Traefik reload using the Docker API.
 */
async function triggerTraefikReload() {
  try {
    logger.info("Attempting to restart Traefik container...");
    const Docker = require("dockerode");
    const docker = new Docker({ socketPath: "/var/run/docker.sock" });

    // Find the Traefik container
    const containers = await docker.listContainers({
      filters: { name: ["traefik"] },
    });

    if (containers.length === 0) {
      logger.error("No Traefik container found");
      return false;
    }

    const traefikContainer = docker.getContainer(containers[0].Id);
    const containerId = containers[0].Id.substring(0, 12);

    // Restart the container
    logger.info(`Restarting Traefik container ${containerId}...`);
    await traefikContainer.restart({ t: 10 }); // 10 seconds timeout

    logger.info("Traefik restarted successfully");
    return true;
  } catch (error) {
    logger.error("Failed to restart Traefik:", {
      error: error.message,
      stack: error.stack,
    });
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

  const isValid = subdomainRegex.test(subdomain) && ipRegex.test(targetIp);

  if (!isValid) {
    logger.warn("Invalid MongoDB input validation:", {
      subdomain: {
        value: subdomain,
        valid: subdomainRegex.test(subdomain),
      },
      targetIp: {
        value: targetIp,
        valid: ipRegex.test(targetIp),
      },
    });
  }

  return isValid;
}

/**
 * Validate subdomain and target URL for HTTP app deployments.
 */
function validateAppInput(subdomain, targetUrl) {
  const subdomainRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  // Simple URL validation (must start with http:// or https://)
  const urlRegex = /^https?:\/\/[a-zA-Z0-9.-]+(?::\d+)?(\/.*)?$/;

  const isValid = subdomainRegex.test(subdomain) && urlRegex.test(targetUrl);

  if (!isValid) {
    logger.warn("Invalid app input validation:", {
      subdomain: {
        value: subdomain,
        valid: subdomainRegex.test(subdomain),
      },
      targetUrl: {
        value: targetUrl,
        valid: urlRegex.test(targetUrl),
      },
    });
  }

  return isValid;
}

/**
 * Function to ensure the MongoDB entrypoint is properly configured
 */
async function ensureMongoDBEntrypoint() {
  try {
    // Use Docker API to check if Traefik is exposing port 27017
    const containers = await docker.listContainers({
      filters: { name: ["traefik"] },
    });

    if (containers.length === 0) {
      logger.error("No Traefik container found");
      return false;
    }

    const traefikContainer = containers[0];
    const ports = traefikContainer.Ports || [];

    // Check if port 27017 is exposed
    const mongoPortExposed = ports.some((port) => port.PublicPort === 27017);

    if (!mongoPortExposed) {
      logger.warn("MongoDB port 27017 is not exposed in Traefik container");
      logger.info("Adding TCP entrypoint for MongoDB in dynamic configuration");

      // Get current dynamic config
      const config = await loadDynamicConfig();

      // Ensure TCP section exists
      if (!config.tcp) {
        config.tcp = { routers: {}, services: {} };
      }

      // Add a default MongoDB router that handles all MongoDB subdomains
      config.tcp.routers["mongodb-default"] = {
        rule: `HostSNI(\`*.${MONGO_DOMAIN}\`)`,
        service: "mongodb-default-service",
        tls: {
          passthrough: true,
        },
      };

      // Empty service as a placeholder (will be updated by specific routes)
      config.tcp.services["mongodb-default-service"] = {
        loadBalancer: {
          servers: [],
        },
      };

      // Save the updated configuration
      await saveDynamicConfig(config);

      logger.info("MongoDB default router added to dynamic configuration");
      logger.info(
        "You need to modify your Traefik container to expose port 27017"
      );
      logger.info(
        "Recommended command: docker-compose down && docker-compose up -d"
      );

      return false;
    }

    logger.info("MongoDB port 27017 is properly exposed in Traefik container");
    return true;
  } catch (err) {
    logger.error("Error checking MongoDB entrypoint:", err);
    return false;
  }
}

/**
 * API status endpoint
 */
app.get("/api/status", (req, res) => {
  logger.debug("Status endpoint called", { ip: req.ip });

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
 * Endpoint for adding a MongoDB subdomain with TLS termination at the front.
 */
app.post("/api/frontdoor/add-subdomain", jwtAuth, async (req, res) => {
  try {
    logger.info("Received add-subdomain request", {
      requestBody: req.body,
      user: req.user,
    });

    const { subdomain, targetIp, agentId } = req.body;

    if (!subdomain || !targetIp) {
      logger.warn("Missing required parameters for add-subdomain", {
        subdomain,
        targetIp,
      });

      return res.status(400).json({
        error:
          "Missing required parameters: subdomain and targetIp are required",
        received: { subdomain, targetIp },
      });
    }

    // Get the agent ID either from the request body or from the JWT token
    const effectiveAgentId = agentId || req.user.agentId || "default";

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

    // Load the agent-specific configuration
    const config = await configManager.getAgentConfig(effectiveAgentId);

    // Ensure the TCP section exists for MongoDB routing
    if (!config.tcp) {
      config.tcp = { routers: {}, services: {} };
    }

    // Check if we should use the agentId as part of the subdomain
    const finalSubdomain =
      subdomain === "mongodb" ? effectiveAgentId : subdomain;

    logger.info("Setting up MongoDB configuration with TLS termination", {
      domain: `${finalSubdomain}.${MONGO_DOMAIN}`,
      agentId: effectiveAgentId,
    });

    // Check if Traefik has port 27017 exposed
    const containers = await docker.listContainers({
      filters: { name: ["traefik"] },
    });

    const traefik = containers.length > 0 ? containers[0] : null;
    const ports = traefik ? traefik.Ports || [] : [];
    const mongoPortExposed = ports.some((port) => port.PublicPort === 27017);

    if (!mongoPortExposed) {
      logger.warn(
        "MongoDB port 27017 is not exposed in Traefik. TCP routing may not work.",
        {
          traefikContainer: traefik ? traefik.Id.substring(0, 12) : "not found",
          exposedPorts: ports
            .map((p) => `${p.PublicPort}:${p.PrivatePort}`)
            .join(", "),
        }
      );
    }

    // Add TCP router for the MongoDB deployment
    config.tcp.routers[`mongodb-${finalSubdomain}`] = {
      rule: `HostSNI(\`${finalSubdomain}.${MONGO_DOMAIN}\`)`,
      entryPoints: ["mongodb"],
      service: `mongodb-${finalSubdomain}-service`,
      tls: {
        passthrough: true,
      },
    };

    // Create the service that forwards to the MongoDB instance
    config.tcp.services[`mongodb-${finalSubdomain}-service`] = {
      loadBalancer: {
        servers: [{ address: `${targetIp}:27017` }],
      },
    };

    // Save the agent-specific configuration
    await configManager.saveAgentConfig(effectiveAgentId, config);

    // Also update the main dynamic config to ensure the mongodb entrypoint is defined
    const mainConfig = await loadDynamicConfig();
    if (!mainConfig.tcp) {
      mainConfig.tcp = { routers: {}, services: {} };
    }

    // Add a catchall router if it doesn't exist
    if (!mainConfig.tcp.routers["mongodb-catchall"]) {
      mainConfig.tcp.routers["mongodb-catchall"] = {
        rule: `HostSNI(\`*.${MONGO_DOMAIN}\`)`,
        service: "mongodb-catchall-service",
        entryPoints: ["mongodb"],
        tls: {
          passthrough: true,
        },
      };

      mainConfig.tcp.services["mongodb-catchall-service"] = {
        loadBalancer: {
          servers: [],
        },
      };

      await saveDynamicConfig(mainConfig);
    }

    const reloadTriggered = await triggerTraefikReload();

    logger.info("MongoDB subdomain added with TLS passthrough", {
      subdomain: finalSubdomain,
      domain: `${finalSubdomain}.${MONGO_DOMAIN}`,
      targetIp,
      agentId: effectiveAgentId,
      reloadTriggered,
      portExposed: mongoPortExposed,
    });

    res.json({
      success: true,
      message: mongoPortExposed
        ? "MongoDB subdomain added successfully with TLS passthrough."
        : "MongoDB subdomain configured, but port 27017 is not exposed in Traefik.",
      details: {
        domain: `${finalSubdomain}.${MONGO_DOMAIN}`,
        targetIp: targetIp,
        agentId: effectiveAgentId,
        reloadTriggered,
        portExposed: mongoPortExposed,
        additionalSetupNeeded: !mongoPortExposed,
        setupInstructions: !mongoPortExposed
          ? "Add port 27017:27017 to your Traefik container in docker-compose.yml and restart with docker-compose down && docker-compose up -d"
          : undefined,
      },
    });
  } catch (err) {
    logger.error("Failed to add MongoDB subdomain:", {
      error: err.message,
      stack: err.stack,
    });

    res.status(500).json({ error: err.message });
  }
});

/**
 * Endpoint for adding an app subdomain.
 */
app.post("/api/frontdoor/add-app", jwtAuth, async (req, res) => {
  try {
    logger.info("Received add-app request", {
      requestBody: req.body,
      user: req.user,
    });

    const { subdomain, targetUrl, agentId } = req.body;

    if (!subdomain || !targetUrl) {
      logger.warn("Missing required parameters for add-app", {
        subdomain,
        targetUrl,
      });

      return res.status(400).json({
        error:
          "Missing required parameters: subdomain and targetUrl are required",
        received: { subdomain, targetUrl },
      });
    }

    // Get the agent ID either from the request body or from the JWT token
    const effectiveAgentId = agentId || req.user.agentId || "default";

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
            pattern: "^https?://[a-zA-Z0-9.-]+(?:\\d+)?(/.*)?$",
          },
        },
      });
    }

    // Extract target host:port from the URL for use in the Host header
    let targetHost = targetUrl;
    try {
      const url = new URL(targetUrl);
      targetHost = url.host; // This gives "hostname:port" or just "hostname" if no port
      logger.debug(`Extracted host from target URL: ${targetHost}`);
    } catch (err) {
      logger.warn(`Failed to parse URL ${targetUrl}:`, { error: err.message });
      // If parsing fails, just keep the original targetUrl
    }

    // Load the agent-specific configuration
    const config = await configManager.getAgentConfig(effectiveAgentId);

    // Ensure http structure exists with middlewares
    config.http = config.http || { routers: {}, services: {}, middlewares: {} };
    config.http.middlewares = config.http.middlewares || {};

    logger.info("Setting up app configuration", {
      domain: `${subdomain}.${APP_DOMAIN}`,
      targetUrl,
      agentId: effectiveAgentId,
    });

    // Create a host rewrite middleware specifically for this service
    const middlewareName = `${subdomain}-host-rewrite`;
    config.http.middlewares[middlewareName] = {
      headers: {
        customRequestHeaders: {
          Host: targetHost,
        },
      },
    };

    // Create an HTTP router for the subdomain with TLS
    config.http.routers[subdomain] = {
      rule: `Host(\`${subdomain}.${APP_DOMAIN}\`)`,
      service: `${subdomain}-service`,
      entryPoints: ["web", "websecure"],
      middlewares: [middlewareName],
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

    // Save the agent-specific configuration
    await configManager.saveAgentConfig(effectiveAgentId, config);

    // Try to trigger a reload, but continue even if it fails
    const reloadTriggered = await triggerTraefikReload();

    logger.info("App subdomain added successfully", {
      subdomain,
      domain: `${subdomain}.${APP_DOMAIN}`,
      targetUrl: targetUrl.startsWith("http")
        ? targetUrl
        : `http://${targetUrl}`,
      agentId: effectiveAgentId,
      reloadTriggered,
    });

    res.json({
      success: true,
      message: "App subdomain added successfully.",
      details: {
        domain: `${subdomain}.${APP_DOMAIN}`,
        targetUrl: targetUrl.startsWith("http")
          ? targetUrl
          : `http://${targetUrl}`,
        agentId: effectiveAgentId,
        reloadTriggered,
      },
    });
  } catch (err) {
    logger.error("Unexpected error in add-app endpoint:", {
      error: err.message,
      stack: err.stack,
    });

    res.status(500).json({ error: err.message });
  }
});

/**
 * Endpoint to retrieve agent-specific configuration
 */
app.get("/api/frontdoor/agent-config/:agentId", jwtAuth, async (req, res) => {
  try {
    const { agentId } = req.params;

    if (!agentId) {
      logger.warn("Missing agent ID in request");
      return res.status(400).json({ error: "Agent ID is required" });
    }

    logger.info("Retrieving configuration for agent", { agentId });
    const config = await configManager.getAgentConfig(agentId);

    res.json({
      success: true,
      agentId,
      config,
    });
  } catch (err) {
    logger.error("Failed to retrieve agent configuration:", {
      error: err.message,
      agentId: req.params.agentId,
    });

    res.status(500).json({ error: err.message });
  }
});

/**
 * Endpoint to list all registered agents
 */
app.get("/api/frontdoor/agents", jwtAuth, async (req, res) => {
  try {
    logger.info("Listing all registered agents");
    const agents = await configManager.listAgents();

    res.json({
      success: true,
      agents,
    });
  } catch (err) {
    logger.error("Failed to list agents:", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * Endpoint to retrieve current global configuration
 */
app.get("/api/frontdoor/config", jwtAuth, async (req, res) => {
  try {
    logger.info("Retrieving global configuration");
    const config = await loadDynamicConfig();
    res.json({ success: true, config });
  } catch (err) {
    logger.error("Failed to retrieve global configuration:", {
      error: err.message,
    });
    res.status(500).json({ error: err.message });
  }
});

/**
 * Healthcheck endpoint.
 */
app.get("/health", (req, res) => {
  logger.debug("Health check requested");
  res.json({ status: "ok" });
});

/**
 * Endpoint for agent registration.
 */
app.post("/api/agent/register", async (req, res) => {
  try {
    const { agentId } = req.body;
    logger.info("Agent registration request received", { agentId });

    if (!agentId) {
      logger.warn("Missing agentId in registration request");
      return res.status(400).json({ error: "agentId is required" });
    }

    // Create an initial config file for this agent
    const initialConfig = {
      http: {
        routers: {},
        services: {},
        middlewares: {},
      },
    };

    // Save the initial config
    await configManager.saveAgentConfig(agentId, initialConfig);
    logger.info("Created initial configuration for agent", { agentId });

    // Generate token for the agent
    const token = generateAgentToken({ agentId });
    logger.info("Agent registered successfully", { agentId });

    // Now automatically register MongoDB for this agent
    try {
      // Get the agent's IP address from the request
      const agentIP =
        req.headers["x-forwarded-for"] || req.connection.remoteAddress;
      const cleanIP = agentIP.replace(/^.*:/, ""); // Handle IPv6 format if present

      logger.info("Automatically registering MongoDB for agent", {
        agentId,
        agentIP: cleanIP,
      });

      // Create a MongoDB subdomain with the agentId pattern
      const mongoSubdomain = `${agentId}`;

      // Load or create MongoDB configuration
      const config = await configManager.getAgentConfig(agentId);

      // Ensure the TCP section exists for MongoDB routing
      if (!config.tcp) {
        config.tcp = { routers: {}, services: {} };
      }

      // Add TCP router and service for the MongoDB deployment
      config.tcp.routers[mongoSubdomain] = {
        rule: `HostSNI(\`${mongoSubdomain}.${MONGO_DOMAIN}\`)`,
        service: `${mongoSubdomain}-mongodb-service`,
      };

      config.tcp.services[`${mongoSubdomain}-mongodb-service`] = {
        loadBalancer: {
          servers: [{ address: `${cleanIP}:27017` }],
        },
      };

      // Save the updated configuration
      await configManager.saveAgentConfig(agentId, config);

      // Attempt to trigger Traefik reload
      const reloadTriggered = await triggerTraefikReload();

      logger.info("MongoDB automatically registered for agent", {
        agentId,
        subdomain: mongoSubdomain,
        domain: `${mongoSubdomain}.${MONGO_DOMAIN}`,
        agentIP: cleanIP,
        reloadTriggered,
      });
    } catch (mongoErr) {
      // Log error but don't fail the agent registration
      logger.error("Failed to automatically register MongoDB", {
        error: mongoErr.message,
        agentId,
      });
    }

    res.json({
      token,
      message: `Agent ${agentId} registered successfully`,
      mongodbUrl: `${agentId}.${MONGO_DOMAIN}`,
    });
  } catch (err) {
    logger.error("Agent registration failed:", {
      error: err.message,
      agentId: req.body.agentId,
    });

    res.status(500).json({ error: err.message });
  }
});

/**
 * Generate JWT for an agent.
 */
function generateAgentToken(payload) {
  logger.debug("Generating agent token", { payload });
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "30d" });
}

async function startServer() {
  try {
    // First initialize config
    logger.info("Initializing configuration system...");
    await initializeConfigFile();
    await configManager.initialize();
    logger.info("Configuration system initialized successfully");

    // Check MongoDB entrypoint
    const mongodbReady = await ensureMongoDBEntrypoint();
    if (!mongodbReady) {
      logger.warn(
        "MongoDB entrypoint not fully configured - TCP routing may not work correctly"
      );
    }

    // Then start the server
    const server = app.listen(PORT, () => {
      logger.info(`Frontdoor API listening on port ${PORT}`);

      // Check if config file is accessible
      fs.access(dynamicConfigPath, fs.constants.R_OK | fs.constants.W_OK)
        .then(() => {
          logger.info(
            `Dynamic config file at ${dynamicConfigPath} is accessible`
          );
          app.emit("ready");
        })
        .catch((err) => {
          logger.error(
            `Cannot access dynamic config file at ${dynamicConfigPath}:`,
            {
              error: err.message,
            }
          );
        });
    });

    // Handle graceful shutdown
    process.on("SIGTERM", () => {
      logger.info("SIGTERM signal received. Shutting down gracefully...");
      server.close(() => {
        logger.info("HTTP server closed.");
        process.exit(0);
      });
    });

    process.on("SIGINT", () => {
      logger.info("SIGINT signal received. Shutting down gracefully...");
      server.close(() => {
        logger.info("HTTP server closed.");
        process.exit(0);
      });
    });
  } catch (err) {
    logger.error("Failed to start server:", {
      error: err.message,
      stack: err.stack,
    });
    process.exit(1);
  }
}

startServer();
