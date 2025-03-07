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

/**
 * Initialize the configuration file with proper structure
 */
async function initializeConfigFile() {
  try {
    console.log("[STARTUP] Checking dynamic config file...");

    // Check if the directory exists, if not create it
    const configDir = path.dirname(dynamicConfigPath);
    try {
      await fs.access(configDir);
    } catch (dirErr) {
      console.log(`[STARTUP] Creating directory: ${configDir}`);
      await fs.mkdir(configDir, { recursive: true });
    }

    // Check if the file exists
    try {
      await fs.access(dynamicConfigPath);
      console.log("[STARTUP] Dynamic config file exists");

      // Check if it has the correct structure
      const content = await fs.readFile(dynamicConfigPath, "utf8");
      let config;

      try {
        config = yaml.parse(content) || {};
      } catch (parseErr) {
        console.error(
          "[STARTUP] Error parsing existing config file:",
          parseErr.message
        );
        console.log(
          "[STARTUP] Creating backup of corrupted file and creating new one"
        );

        // Backup the corrupted file
        const backupPath = `${dynamicConfigPath}.corrupted.${Date.now()}`;
        await fs.copyFile(dynamicConfigPath, backupPath);

        // Create a new config with proper structure
        config = {
          http: { routers: {}, services: {} },
        };
      }

      let needsUpdate = false;

      // Make sure required sections exist
      if (!config.http) {
        config.http = { routers: {}, services: {} };
        needsUpdate = true;
      }

      if (needsUpdate) {
        console.log(
          "[STARTUP] Updating dynamic config file with proper structure"
        );
        const yamlStr = yaml.stringify(config, { indent: 2 });
        await fs.writeFile(dynamicConfigPath, yamlStr, "utf8");
      }
    } catch (accessErr) {
      // File doesn't exist, create it
      console.log(
        "[STARTUP] Creating dynamic config file with initial structure"
      );
      const initialConfig = {
        http: { routers: {}, services: {} },
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
      console.log("[STARTUP] Write permissions verified for config directory");
    } catch (permErr) {
      console.error(
        "[ERROR] No write permissions to config directory:",
        permErr.message
      );
      console.warn(
        "[WARN] Node app may not be able to update dynamic configuration!"
      );
    }

    console.log("[STARTUP] Dynamic config file initialized successfully");
  } catch (err) {
    console.error("[STARTUP] Failed to initialize dynamic config file:", err);
  }
}

// Call initialization function at startup
initializeConfigFile().catch((err) => {
  console.error("[STARTUP] Initialization error:", err);
});

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
 * Load dynamic configuration from dynamic.yml.
 */
async function loadDynamicConfig() {
  let config;
  try {
    const content = await fs.readFile(dynamicConfigPath, "utf8");
    config = yaml.parse(content) || {};

    // Remove root-level invalid keys
    delete config.routers;
    delete config.services;
    delete config.tls;
  } catch (err) {
    config = {
      http: { routers: {}, services: {} },
    };
  }

  // Ensure proper structure
  config.http = config.http || { routers: {}, services: {} };

  // Clean nested sections
  config.http.routers = config.http.routers || {};
  config.http.services = config.http.services || {};

  return config;
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
    console.log(
      `[DEBUG] Successfully wrote ${yamlStr.length} bytes to ${dynamicConfigPath}`
    );

    // Validate the YAML after writing (optional, for debugging)
    try {
      const writtenContent = await fs.readFile(dynamicConfigPath, "utf8");
      const parsedContent = yaml.parse(writtenContent);
      console.log("[DEBUG] YAML validation successful");
    } catch (validateErr) {
      console.error(
        "[ERROR] Written YAML failed validation:",
        validateErr.message
      );
    }
  } catch (writeErr) {
    console.error(
      `[ERROR] Failed to write to ${dynamicConfigPath}:`,
      writeErr.message
    );
    throw writeErr;
  }
}

function executeCommand(command, args = [], options = {}) {
  const { spawn } = require("child_process");
  const { cwd = process.cwd() } = options;

  console.log(`Executing command: ${command} ${args.join(" ")}`);

  return new Promise((resolve, reject) => {
    const cmd = spawn(command, args, {
      cwd,
      stdio: ["inherit", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    cmd.stdout.on("data", (data) => {
      const output = data.toString();
      stdout += output;
      console.log(`[stdout] ${output.trim()}`);
    });

    cmd.stderr.on("data", (data) => {
      const output = data.toString();
      stderr += output;
      console.error(`[stderr] ${output.trim()}`);
    });

    cmd.on("close", (code) => {
      if (code !== 0) {
        const error = new Error(`Command failed with exit code ${code}`);
        error.code = code;
        error.stdout = stdout.trim();
        error.stderr = stderr.trim();
        console.error(`Command failed: ${command} ${args.join(" ")}`);
        console.error(`Exit code: ${code}`);
        if (stderr) {
          console.error(`Error output: ${stderr.trim()}`);
        }
        reject(error);
      } else {
        console.log(`Command succeeded: ${command} ${args.join(" ")}`);
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      }
    });

    cmd.on("error", (error) => {
      console.error(`Failed to start command: ${command} ${args.join(" ")}`);
      console.error(`Error: ${error.message}`);
      reject(error);
    });
  });
}

/**
 * Trigger Traefik reload using the Docker API.
 */
async function triggerTraefikReload() {
  try {
    // Try using "docker compose" (new format without hyphen)
    const { spawn } = require("child_process");
    console.log("Restarting Traefik using docker compose...");

    // Using spawn directly for more control
    const process = spawn(
      "docker",
      [
        "compose",
        "-f",
        "/opt/cloudlunacy_front/docker-compose.yml",
        "restart",
        "traefik",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let stdout = "";
    let stderr = "";

    process.stdout.on("data", (data) => {
      stdout += data.toString();
      console.log(`[Traefik restart stdout] ${data.toString().trim()}`);
    });

    process.stderr.on("data", (data) => {
      stderr += data.toString();
      console.error(`[Traefik restart stderr] ${data.toString().trim()}`);
    });

    const exitCode = await new Promise((resolve, reject) => {
      process.on("close", resolve);
      process.on("error", (err) => {
        console.error("Process error:", err);
        reject(err);
      });
    });

    if (exitCode === 0) {
      console.log("Traefik restarted successfully");
      return true;
    } else {
      console.error(`Traefik restart failed with exit code ${exitCode}`);
      console.error(`Error output: ${stderr}`);

      // Try alternative method as fallback: use dockerode
      console.log("Trying alternative restart method via Dockerode...");
      try {
        const Docker = require("dockerode");
        const docker = new Docker({ socketPath: "/var/run/docker.sock" });

        const containers = await docker.listContainers({
          filters: { name: ["traefik"] },
        });

        if (containers.length === 0) {
          console.error("No Traefik container found");
          return false;
        }

        const traefikContainer = docker.getContainer(containers[0].Id);

        // Restart the container
        console.log(`Restarting Traefik container ${containers[0].Id}...`);
        await traefikContainer.restart({ t: 10 }); // 10 seconds timeout

        console.log("Traefik restarted successfully via Dockerode");
        return true;
      } catch (dockerodeError) {
        console.error(
          "Alternative restart also failed:",
          dockerodeError.message
        );
        return false;
      }
    }
  } catch (error) {
    console.error("Failed to restart Traefik:", error.message);
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

    // Load the current dynamic configuration
    const config = await loadDynamicConfig();
    // Ensure the TCP section exists only when needed
    if (!config.tcp) {
      config.tcp = { routers: {}, services: {} };
    }

    console.log(
      "[DEBUG] Setting up configuration for domain:",
      `${subdomain}.${MONGO_DOMAIN}`
    );

    // Add TCP router and service for the MongoDB deployment
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
    console.error("[ERROR] Failed to add MongoDB subdomain:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Modified code for the /api/frontdoor/add-app endpoint to ensure proper
 * middleware setup for Host header rewriting.
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
    } catch (err) {
      console.warn(`[WARN] Failed to parse URL ${targetUrl}: ${err.message}`);
      // If parsing fails, just keep the original targetUrl
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
        http: { routers: {}, services: {}, middlewares: {} },
        tcp: { routers: {}, services: {} },
      };
    }

    // Ensure http structure exists with middlewares
    config.http = config.http || { routers: {}, services: {}, middlewares: {} };
    config.http.middlewares = config.http.middlewares || {};

    console.log(
      "[DEBUG] Setting up configuration for domain:",
      `${subdomain}.${APP_DOMAIN}`
    );

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
    console.log("[DEBUG] Traefik reload triggered:", reloadTriggered);

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
app.listen(PORT, () => {
  console.log(`Frontdoor API listening on port ${PORT}`);

  // Final configuration file check
  fs.access(dynamicConfigPath, fs.constants.R_OK | fs.constants.W_OK)
    .then(() => {
      console.log(
        `[STARTUP] Dynamic config file at ${dynamicConfigPath} is accessible`
      );
    })
    .catch((err) => {
      console.error(
        `[STARTUP] Cannot access dynamic config file at ${dynamicConfigPath}:`,
        err.message
      );
    });
});
