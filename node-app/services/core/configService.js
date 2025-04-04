/**
 * Configuration Service
 *
 * Single source of truth for all configuration management.
 * Handles loading, saving, and validating configuration files.
 */

const fs = require("fs").promises;
const path = require("path");
const logger = require("../../utils/logger").getLogger("configService");
const pathManager = require("../../utils/pathManager");

class ConfigService {
  constructor() {
    // Configuration paths
    this.paths = {
      base: process.env.CONFIG_BASE_PATH || "/app/config",
      agents: process.env.AGENTS_CONFIG_DIR || "/app/config/agents",
      haproxy:
        process.env.HAPROXY_CONFIG_PATH || "/app/config/haproxy/haproxy.cfg",
      docker: process.env.DOCKER_COMPOSE_PATH || "/app/docker-compose.yml",
    };

    // Configuration domains
    this.domains = {
      mongo: process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk",
      app: process.env.APP_DOMAIN || "apps.cloudlunacy.uk",
    };

    // Loaded configurations
    this.configs = {
      agents: new Map(),
      haproxy: null,
    };

    this.initialized = false;
  }

  /**
   * Initialize the configuration service
   */
  async initialize() {
    if (this.initialized) {
      return true;
    }

    try {
      logger.info("Initializing configuration service");

      // Initialize path manager if needed
      if (!pathManager.initialized) {
        await pathManager.initialize();
      }

      // Ensure configuration directories exist
      await pathManager.ensureDirectory(this.paths.base);
      await pathManager.ensureDirectory(this.paths.agents);

      // Load HAProxy configuration
      await this.loadHAProxyConfig();

      this.initialized = true;
      logger.info("Configuration service initialized successfully");
      return true;
    } catch (err) {
      logger.error(
        `Failed to initialize configuration service: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
        }
      );

      // Try recovery with fallback paths
      try {
        logger.info("Attempting recovery with fallback paths");
        await this.resolvePathsFallback();
        await this.ensureDirectories();
        await this.loadHAProxyConfig();

        this.initialized = true;
        logger.info("Configuration service initialized with fallback paths");
        return true;
      } catch (recoveryErr) {
        logger.error(`Recovery failed: ${recoveryErr.message}`);
        throw err;
      }
    }
  }

  /**
   * Resolve configuration paths
   */
  async resolvePaths() {
    try {
      // Resolve base config path
      this.paths.base = await pathManager.resolvePath("config");

      // Resolve other paths based on base path
      this.paths.agents = path.join(this.paths.base, "agents");
      this.paths.haproxy = path.join(this.paths.base, "haproxy/haproxy.cfg");

      logger.debug("Resolved configuration paths", { paths: this.paths });
      return true;
    } catch (err) {
      logger.error(`Failed to resolve paths: ${err.message}`);
      throw err;
    }
  }

  /**
   * Fallback path resolution for recovery
   */
  async resolvePathsFallback() {
    // Use hardcoded paths as fallback
    this.paths.base = "/app/config";
    this.paths.agents = "/app/config/agents";
    this.paths.haproxy = "/app/config/haproxy/haproxy.cfg";

    logger.debug("Using fallback configuration paths", { paths: this.paths });
    return true;
  }

  /**
   * Ensure required directories exist
   */
  async ensureDirectories() {
    try {
      // Ensure base config directory exists
      await pathManager.ensureDirectory(this.paths.base);

      // Ensure agents directory exists
      await pathManager.ensureDirectory(this.paths.agents);

      return true;
    } catch (err) {
      logger.error(`Failed to ensure directories: ${err.message}`);
      throw err;
    }
  }

  /**
   * Load HAProxy configuration
   */
  async loadHAProxyConfig() {
    try {
      // Try to read the HAProxy config file (as plain text, not YAML)
      try {
        const content = await fs.readFile(this.paths.haproxy, "utf8");
        this.configs.haproxy = content;
        logger.debug("Loaded HAProxy configuration from file");
      } catch (err) {
        // If file doesn't exist, use a default template
        logger.warn(`Failed to load HAProxy configuration: ${err.message}`);
        logger.info("Using default template for HAProxy configuration");

        // Create a default HAProxy configuration
        this.configs.haproxy = this.getDefaultHAProxyConfig();

        // Save the default configuration to file
        await this.saveHAProxyConfig();
      }

      return true;
    } catch (err) {
      logger.error(`Failed to load HAProxy configuration: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get the default HAProxy configuration template
   * @returns {string} Default HAProxy configuration
   */
  getDefaultHAProxyConfig() {
    return `# HAProxy Configuration for CloudLunacy Front Server
global
    log stdout format raw local0 info
    log stderr format raw local1 notice
    stats socket /tmp/haproxy.sock mode 660 level admin expose-fd listeners
    stats timeout 30s
    user haproxy
    group haproxy
    daemon
    maxconn 20000
    
    # Enable runtime API
    stats socket ipv4@127.0.0.1:9999 level admin
    stats timeout 2m

defaults
    log global
    mode http
    option httplog
    option dontlognull
    timeout connect 5000ms
    timeout client 50000ms
    timeout server 50000ms

# Stats page
frontend stats
    bind *:8081
    stats enable
    stats uri /stats
    stats refresh 10s
    stats auth admin:admin_password
    stats admin if TRUE

# Frontend for HTTP traffic
frontend http-in
    bind *:80
    mode http
    option forwardfor
    default_backend node-app-backend
    
# Backend for Node.js app
backend node-app-backend
    mode http
    option httpchk GET /health
    http-check expect status 200
    server node_app node-app:3005 check inter 5s rise 2 fall 3

# Default MongoDB Backend
backend mongodb_default
    mode tcp
    server mongodb1 127.0.0.1:27018 check

# Frontend for MongoDB traffic with TLS/SSL and SNI support
frontend mongodb-in
    # Use certificate list to support multiple agent certificates
    bind *:27017 ssl crt-list /etc/ssl/certs/mongodb-certs.list
    mode tcp
    option tcplog
    
    # Add enhanced logging to debug SSL connections
    log-format "%ci:%cp [%t] %ft %b/%s %Tw/%Tc/%Tt %B %ts %ac/%fc/%bc/%sc/%rc %sq/%bq sslv:%sslv sni:%[ssl_fc_sni] %[ssl_fc_session_id,hex]"
    
    # Extract the agent ID from the SNI hostname for routing
    http-request set-var(txn.agent_id) req.ssl_sni,field(1,".")
    
    # Use agent-specific backend if SNI is provided
    use_backend %[ssl_fc_sni,field(1,'.')]-mongodb-backend if { ssl_fc_has_sni }
    
    # Default backend if no SNI
    default_backend mongodb_default`;
  }

  /**
   * Save the HAProxy configuration to file
   */
  async saveHAProxyConfig() {
    try {
      if (!this.configs.haproxy) {
        throw new Error("HAProxy configuration is not loaded");
      }

      await fs.writeFile(this.paths.haproxy, this.configs.haproxy, "utf8");
      logger.debug("Saved HAProxy configuration to file");
      return true;
    } catch (err) {
      logger.error(`Failed to save HAProxy configuration: ${err.message}`);
      throw err;
    }
  }

  /**
   * Add or update a MongoDB backend server in the HAProxy configuration
   * @param {string} agentId - Agent ID
   * @param {string} targetIp - Target IP address
   * @param {number} targetPort - Target port
   * @returns {Promise<boolean>} Success status
   */
  async updateMongoDBBackend(agentId, targetIp, targetPort = 27017) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      if (!this.configs.haproxy) {
        await this.loadHAProxyConfig();
      }

      // Generate the server line
      const serverLine = `    server mongodb-agent-${agentId} ${targetIp}:${targetPort} check`;

      // Check if the mongodb_default backend exists
      const backendRegex =
        /backend\s+mongodb_default\s*\n([\s\S]*?)(?=\n\s*\n|\n\s*#|\n\s*backend|\s*$)/;
      const backendMatch = this.configs.haproxy.match(backendRegex);

      let updatedConfig;
      if (!backendMatch) {
        // Backend doesn't exist, need to create structured sections
        const sections = {
          frontend: `
# Frontend for MongoDB traffic
frontend mongodb-in
    bind *:27017
    mode tcp
    option tcplog
    default_backend mongodb_default`,
          backend: `
# MongoDB Backend for ${agentId}
backend mongodb_default
    mode tcp
${serverLine}`,
        };

        // Check if mongodb frontend already exists to avoid duplicates
        if (!this.configs.haproxy.includes("frontend mongodb-in")) {
          updatedConfig = `${this.configs.haproxy}\n${sections.frontend}\n${sections.backend}\n`;
        } else {
          // Frontend exists but backend doesn't - unusual situation
          updatedConfig = `${this.configs.haproxy}\n${sections.backend}\n`;
        }
      } else {
        // Backend exists, check if this agent already has a server line
        const agentServerRegex = new RegExp(
          "server\\s+mongodb-agent-" + agentId + "\\s+.*",
          "m"
        );
        const existingServerLine = backendMatch[0].match(agentServerRegex);

        if (existingServerLine) {
          // Replace existing server line
          updatedConfig = this.configs.haproxy.replace(
            agentServerRegex,
            serverLine
          );
        } else {
          // Add new server line to existing backend
          const lines = backendMatch[0].trim().split("\n");

          // Insert the new server line in a safe position
          // If the last line is a comment, insert before it
          if (
            lines.length > 0 &&
            lines[lines.length - 1].trim().startsWith("#")
          ) {
            lines.splice(lines.length - 1, 0, serverLine);
          } else {
            lines.push(serverLine);
          }

          const updatedBackend = lines.join("\n");
          updatedConfig = this.configs.haproxy.replace(
            backendMatch[0],
            updatedBackend
          );
        }
      }

      // Validate the configuration before saving
      this._validateHAProxyConfig(updatedConfig);

      // Update the configuration and save
      this.configs.haproxy = updatedConfig;
      await this.saveHAProxyConfig();

      logger.info(`Updated MongoDB backend for agent ${agentId}`);
      return true;
    } catch (err) {
      logger.error(`Failed to update MongoDB backend: ${err.message}`);
      return false;
    }
  }

  /**
   * Validate HAProxy configuration for common errors
   * @param {string} config - The configuration to validate
   * @returns {boolean} True if valid, throws error otherwise
   * @private
   */
  _validateHAProxyConfig(config) {
    // Check for server directives outside backend sections
    const serverDirectiveRegex = /^(?!\s*backend).*?\s+server\s+\S+/m;
    if (serverDirectiveRegex.test(config)) {
      throw new Error("Server directive found outside of backend section");
    }

    // Check for duplicate sections
    const sections = {
      frontend: new Map(),
      backend: new Map(),
    };

    // Check frontends
    const frontendRegex = /frontend\s+(\S+)/g;
    let match;
    while ((match = frontendRegex.exec(config)) !== null) {
      const name = match[1];
      if (sections.frontend.has(name)) {
        throw new Error(`Duplicate frontend section found: ${name}`);
      }
      sections.frontend.set(name, true);
    }

    // Check backends
    const backendRegex = /backend\s+(\S+)/g;
    while ((match = backendRegex.exec(config)) !== null) {
      const name = match[1];
      if (sections.backend.has(name)) {
        throw new Error(`Duplicate backend section found: ${name}`);
      }
      sections.backend.set(name, true);
    }

    return true;
  }

  /**
   * Add or update a Redis backend server in the HAProxy configuration
   * @param {string} agentId - Agent ID
   * @param {string} targetIp - Target IP address
   * @param {number} targetPort - Target port
   * @returns {Promise<boolean>} Success status
   */
  async updateRedisBackend(agentId, targetIp, targetPort = 6379) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      if (!this.configs.haproxy) {
        await this.loadHAProxyConfig();
      }

      // Generate the server line
      const serverLine = `    server redis-agent-${agentId} ${targetIp}:${targetPort} check`;

      // Check if the redis_default backend exists
      const backendRegex =
        /backend\s+redis_default\s*\n([\s\S]*?)(?=\n\s*\n|\n\s*#|\n\s*backend|\s*$)/;
      const backendMatch = this.configs.haproxy.match(backendRegex);

      let updatedConfig;
      if (!backendMatch) {
        // Backend doesn't exist, add it
        const newBackend = `\n# Redis Backend for ${agentId}\nbackend redis_default\n    mode tcp\n${serverLine}\n`;
        updatedConfig = this.configs.haproxy + newBackend;

        // Also add the frontend if it doesn't exist
        if (!this.configs.haproxy.includes("frontend redis-in")) {
          updatedConfig +=
            "\n# Frontend for Redis traffic\nfrontend redis-in\n    bind *:6379\n    mode tcp\n    option tcplog\n    default_backend redis_default\n";
        }
      } else {
        // Backend exists, check if this agent already has a server line
        const agentServerRegex = new RegExp(
          "server\\s+redis-agent-" + agentId + "\\s+.*",
          "m"
        );
        const existingServerLine = backendMatch[0].match(agentServerRegex);

        if (existingServerLine) {
          // Replace existing server line
          updatedConfig = this.configs.haproxy.replace(
            agentServerRegex,
            serverLine
          );
        } else {
          // Add new server line to existing backend
          const lastLine = backendMatch[0].trim().split("\n").pop();
          const updatedBackend = backendMatch[0].replace(
            lastLine,
            `${lastLine}\n${serverLine}`
          );
          updatedConfig = this.configs.haproxy.replace(
            backendMatch[0],
            updatedBackend
          );
        }
      }

      // Update the configuration and save
      this.configs.haproxy = updatedConfig;
      await this.saveHAProxyConfig();

      logger.info(`Updated Redis backend for agent ${agentId}`);
      return true;
    } catch (err) {
      logger.error(`Failed to update Redis backend: ${err.message}`);
      return false;
    }
  }

  /**
   * Remove a MongoDB backend server from the HAProxy configuration
   * @param {string} agentId - Agent ID
   * @returns {Promise<boolean>} Success status
   */
  async removeMongoDBBackend(agentId) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      if (!this.configs.haproxy) {
        await this.loadHAProxyConfig();
      }

      // Pattern to find the server line
      const serverRegex = new RegExp(
        "\\s*server\\s+mongodb-agent-" + agentId + "\\s+[^\\n]+\\n",
        "g"
      );

      // Check if the pattern exists in the configuration
      if (!serverRegex.test(this.configs.haproxy)) {
        logger.info(`No MongoDB backend found for agent ${agentId}`);
        return true;
      }

      // Remove the server line
      const updatedConfig = this.configs.haproxy.replace(serverRegex, "\n");
      this.configs.haproxy = updatedConfig;

      await this.saveHAProxyConfig();
      logger.info(`Removed MongoDB backend for agent ${agentId}`);
      return true;
    } catch (err) {
      logger.error(`Failed to remove MongoDB backend: ${err.message}`);
      return false;
    }
  }

  /**
   * Remove a Redis backend server from the HAProxy configuration
   * @param {string} agentId - Agent ID
   * @returns {Promise<boolean>} Success status
   */
  async removeRedisBackend(agentId) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      if (!this.configs.haproxy) {
        await this.loadHAProxyConfig();
      }

      // Pattern to find the server line
      const serverRegex = new RegExp(
        "\\s*server\\s+redis-agent-" + agentId + "\\s+[^\\n]+\\n",
        "g"
      );

      // Check if the pattern exists in the configuration
      if (!serverRegex.test(this.configs.haproxy)) {
        logger.info(`No Redis backend found for agent ${agentId}`);
        return true;
      }

      // Remove the server line
      const updatedConfig = this.configs.haproxy.replace(serverRegex, "\n");
      this.configs.haproxy = updatedConfig;

      await this.saveHAProxyConfig();
      logger.info(`Removed Redis backend for agent ${agentId}`);
      return true;
    } catch (err) {
      logger.error(`Failed to remove Redis backend: ${err.message}`);
      return false;
    }
  }

  /**
   * Get configuration for a specific agent
   * @param {string} agentId - Agent ID
   * @returns {Promise<Object>} Agent configuration
   */
  async getAgentConfig(agentId) {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // Construct the agent config file path
      const agentConfigPath = path.join(this.paths.agents, `${agentId}.yml`);

      // Check if the agent config file exists
      let configExists = true;
      try {
        await fs.access(agentConfigPath);
      } catch (_err) {
        configExists = false;
        logger.warn(
          `Agent config file not found for agent ${agentId}, will create one`
        );

        // Create a basic agent configuration file
        const basicConfig = `# Configuration for agent ${agentId}
agent:
  id: ${agentId}
  registered: true
  registeredAt: ${new Date().toISOString()}
`;
        try {
          await fs.writeFile(agentConfigPath, basicConfig, "utf8");
          logger.info(`Created basic configuration file for agent ${agentId}`);
          configExists = true;
        } catch (writeErr) {
          logger.error(
            `Failed to create agent config file: ${writeErr.message}`
          );
        }
      }

      if (!configExists) {
        return {
          success: false,
          message: `Failed to create configuration for agent ${agentId}`,
        };
      }

      // Look for MongoDB backend for this agent
      const mongoBackendExists =
        this.configs.haproxy &&
        this.configs.haproxy.includes(`mongodb-agent-${agentId}`);

      // Look for Redis backend for this agent
      const redisBackendExists =
        this.configs.haproxy &&
        this.configs.haproxy.includes(`redis-agent-${agentId}`);

      // Generate certificates if they don't exist or need refreshing
      let certificates = null;
      try {
        // Check if we have access to the certificate service
        const coreServices = require("../core");
        if (coreServices && coreServices.certificateService) {
          logger.info(`Generating certificates for agent ${agentId}`);

          // Get the agent's IP address from agent service if available
          let agentIp = null;
          if (coreServices.agentService) {
            try {
              // Check if agent service has a record for this agent
              const agentData = coreServices.agentService.agents.get(agentId);
              if (agentData && agentData.targetIp) {
                agentIp = agentData.targetIp;
                logger.info(`Using stored IP ${agentIp} for agent ${agentId}`);
              }
            } catch (ipErr) {
              logger.warn(
                `Failed to get agent IP for ${agentId}: ${ipErr.message}`
              );
            }
          }

          // If no IP found, use a fallback that works with the agent
          if (!agentIp) {
            // Use a more appropriate fallback than localhost
            // Extract IP from request if possible or use a default
            agentIp = "0.0.0.0"; // This is better than 127.0.0.1 for certificates
            logger.warn(
              `Using fallback IP ${agentIp} for agent ${agentId} certificates`
            );
          }

          // Generate certificates
          const certResult =
            await coreServices.certificateService.generateAgentCertificate(
              agentId,
              agentIp
            );

          if (certResult && certResult.success) {
            certificates = {
              caCert: certResult.caCert,
              serverCert: certResult.serverCert,
              serverKey: certResult.serverKey,
            };
            logger.info(`Certificates generated for agent ${agentId}`);
          } else {
            logger.warn(
              `Failed to generate certificates for agent ${agentId}: ${
                certResult ? certResult.error : "Unknown error"
              }`
            );
          }
        } else {
          logger.warn(
            `Certificate service not available, skipping certificate generation for agent ${agentId}`
          );
        }
      } catch (certErr) {
        logger.error(
          `Error generating certificates for agent ${agentId}: ${certErr.message}`
        );
      }

      // Return agent configuration summary with certificates if available
      const result = {
        success: true,
        agentId,
        haproxy: {
          mongodb: mongoBackendExists,
          redis: redisBackendExists,
        },
        domains: {
          mongodb: mongoBackendExists
            ? `${agentId}.${this.domains.mongo}`
            : null,
          app: `*.${agentId}.${this.domains.app}`,
        },
      };

      // Add certificates if available
      if (certificates) {
        result.certificates = certificates;
      }

      return result;
    } catch (err) {
      logger.error(
        `Failed to get agent config for ${agentId}: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
        }
      );
      throw err;
    }
  }

  /**
   * List all agent IDs
   */
  async listAgents() {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const files = await fs.readdir(this.paths.agents);
      return files
        .filter((file) => file.endsWith(".yml") && file !== "default.yml")
        .map((file) => file.replace(".yml", ""));
    } catch (err) {
      logger.error(`Failed to list agents: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return [];
    }
  }

  /**
   * Repair the configuration
   */
  async repair() {
    logger.info("Repairing configuration");

    // Reset state
    this.initialized = false;
    this.configs.agents.clear();
    this.configs.haproxy = null;

    // Re-initialize
    await this.initialize();

    // Reset HAProxy config with a clean template
    this.configs.haproxy = this.getDefaultHAProxyConfig();
    await this.saveHAProxyConfig();

    logger.info("Configuration repair completed");
    return true;
  }
}

module.exports = ConfigService;
