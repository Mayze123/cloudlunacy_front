/**
 * HAProxy Manager
 *
 * Manages MongoDB and Redis routes in HAProxy configuration based on agentId.
 */

const fs = require("fs").promises;
const path = require("path");
const { execAsync } = require("../../utils/exec");
const logger = require("../../utils/logger").getLogger("haproxyManager");

class HAProxyManager {
  constructor(configManager) {
    this.configManager = configManager;
    this.initialized = false;
    this.routeCache = new Map();
    this.mongoDomain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
    this.redisDomain = process.env.REDIS_DOMAIN || "redis.cloudlunacy.uk";
    this.haproxyContainer = process.env.HAPROXY_CONTAINER || "haproxy";
    this.haproxyConfigPath = "/usr/local/etc/haproxy/haproxy.cfg"; // Path inside container
    this.hostConfigPath =
      process.env.HAPROXY_CONFIG_PATH ||
      path.join(process.cwd(), "config", "haproxy", "haproxy.cfg");
    this.mongoDBServers = [];
  }

  /**
   * Initialize the HAProxy manager
   */
  async initialize() {
    logger.info("Initializing HAProxy manager");

    try {
      // Make sure config manager is initialized if needed
      if (this.configManager && !this.configManager.initialized) {
        await this.configManager.initialize();
      }

      // Verify HAProxy is running
      await this._verifyHAProxyRunning();

      // Load existing configuration and parse it to find existing servers
      await this._loadConfiguration();

      this.initialized = true;
      logger.info("HAProxy manager initialized successfully");
      return true;
    } catch (err) {
      logger.error(`Failed to initialize HAProxy manager: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return false;
    }
  }

  /**
   * Verify HAProxy is running
   */
  async _verifyHAProxyRunning() {
    try {
      const { stdout } = await execAsync(
        `docker ps -q -f name=${this.haproxyContainer}`
      );

      if (!stdout.trim()) {
        throw new Error(
          `HAProxy container '${this.haproxyContainer}' is not running`
        );
      }

      logger.info(`HAProxy container is running with ID: ${stdout.trim()}`);
      return true;
    } catch (err) {
      logger.error(`Failed to verify HAProxy is running: ${err.message}`);
      throw err;
    }
  }

  /**
   * Load HAProxy configuration
   */
  async _loadConfiguration() {
    try {
      // Read configuration from file
      const configContent = await fs.readFile(this.hostConfigPath, "utf8");

      logger.info("HAProxy configuration loaded successfully");
      this.currentConfig = configContent;

      // Parse loaded configuration to extract current routes
      await this._parseConfiguration(configContent);

      return true;
    } catch (err) {
      logger.error(`Failed to load HAProxy configuration: ${err.message}`);
      throw err;
    }
  }

  /**
   * Parse HAProxy configuration to extract routes
   *
   * @param {string} configContent - HAProxy configuration content
   */
  async _parseConfiguration(configContent) {
    // Clear route cache and server list
    this.routeCache.clear();
    this.mongoDBServers = [];

    try {
      // Extract mongodb backend information and server entries
      // Use a regex to find the mongodb_default backend and its server entries
      const backendRegex =
        /backend\s+mongodb_default\s*[\s\S]*?(?=\n\s*\n|\n\s*#|\n\s*backend|\s*$)/;
      const backendMatch = configContent.match(backendRegex);

      if (backendMatch) {
        // Extract server lines - looking for mongodb-agent-XXXX pattern
        const serverRegex =
          /server\s+(mongodb-agent-[\w-]+)\s+([^:\s]+):(\d+)/g;
        let serverMatch;

        while ((serverMatch = serverRegex.exec(backendMatch[0])) !== null) {
          const [, serverName, targetHost, targetPort] = serverMatch;

          // Try to extract the agent ID from the server name
          const agentIdMatch = serverName.match(/mongodb-agent-([\w-]+)/);
          const agentId = agentIdMatch ? agentIdMatch[1] : null;

          if (agentId) {
            // Add to MongoDB servers list
            this.mongoDBServers.push({
              name: serverName,
              agentId,
              address: targetHost,
              port: parseInt(targetPort, 10),
              lastUpdated: new Date().toISOString(),
            });

            // Also add to route cache for backward compatibility
            this.routeCache.set(`mongo:${agentId}`, {
              name: serverName,
              agentId,
              targetHost,
              targetPort: parseInt(targetPort, 10),
              lastUpdated: new Date().toISOString(),
            });

            logger.info(
              `Found MongoDB server: ${serverName} (${targetHost}:${targetPort})`
            );
          }
        }
      }

      logger.info(
        `Loaded ${this.mongoDBServers.length} MongoDB servers from HAProxy configuration`
      );
      return true;
    } catch (err) {
      logger.error(`Failed to parse HAProxy configuration: ${err.message}`);
      throw err;
    }
  }

  /**
   * Update HAProxy MongoDB backend server using the improved template-based system
   *
   * @param {string} agentId - The agent ID
   * @param {string} targetHost - Target host
   * @param {number} targetPort - Target port (default: 27017)
   * @returns {Promise<Object>} Result of the operation
   */
  async updateMongoDBBackend(agentId, targetHost, targetPort = 27017) {
    logger.info(
      `Updating MongoDB backend for agentId: ${agentId}, target: ${targetHost}:${targetPort}`
    );

    if (!this.initialized) {
      logger.info("HAProxy manager not initialized, initializing now...");
      await this.initialize();
    }

    try {
      // Validations
      if (!agentId) {
        throw new Error("Agent ID is required");
      }

      if (!targetHost) {
        throw new Error("Target host is required");
      }

      // Update the MongoDB server list
      const existingServerIndex = this.mongoDBServers.findIndex(
        (server) => server.agentId === agentId
      );

      if (existingServerIndex !== -1) {
        // Update existing server
        this.mongoDBServers[existingServerIndex] = {
          name: `mongodb-agent-${agentId}`,
          agentId,
          address: targetHost,
          port: targetPort,
          lastUpdated: new Date().toISOString(),
        };
      } else {
        // Add new server
        this.mongoDBServers.push({
          name: `mongodb-agent-${agentId}`,
          agentId,
          address: targetHost,
          port: targetPort,
          lastUpdated: new Date().toISOString(),
        });
      }

      // Check for SSL certificate availability
      let useSsl = false;
      let sslCertPath = null;

      try {
        // Check if mongodb.pem exists
        await fs.access("/etc/ssl/certs/mongodb.pem");
        useSsl = true;
        sslCertPath = "/etc/ssl/certs/mongodb.pem";
        logger.info("MongoDB SSL certificate found, enabling SSL");
      } catch (certErr) {
        // Check if we have a server.pem we can use
        try {
          const serverPemPath = path.join(
            process.cwd(),
            "config",
            "certs",
            "agents",
            agentId,
            "server.pem"
          );

          await fs.access(serverPemPath);

          // Copy the server.pem to the expected location
          const destPath = "/etc/ssl/certs/mongodb.pem";
          await fs.mkdir(path.dirname(destPath), { recursive: true });
          await fs.copyFile(serverPemPath, destPath);

          useSsl = true;
          sslCertPath = destPath;
          logger.info(
            `Copied agent certificate ${serverPemPath} to ${destPath}, enabling SSL`
          );
        } catch (certErr2) {
          logger.warn(
            `No valid SSL certificate found, disabling SSL: ${certErr2.message}`
          );
          useSsl = false;
        }
      }

      // Generate configuration data
      const configData = {
        statsPassword: "admin_password", // Should come from a secure config
        includeHttp: true,
        includeMongoDB: true,
        useSsl,
        sslCertPath,
        mongoDBServers: this.mongoDBServers,
      };

      // Use the template-based config manager to update the config
      if (this.configManager) {
        await this.configManager.saveConfig(configData);
        await this.configManager.applyConfig();

        logger.info(
          `MongoDB backend for agent ${agentId} updated successfully with template-based config`
        );

        // Update route cache for backward compatibility
        this.routeCache.set(`mongo:${agentId}`, {
          name: `mongodb-agent-${agentId}`,
          agentId,
          targetHost,
          targetPort,
          lastUpdated: new Date().toISOString(),
        });

        return {
          success: true,
          message: `MongoDB backend for agent ${agentId} updated successfully`,
          useSsl,
          agentId,
          targetHost,
          targetPort,
        };
      } else {
        // Fall back to manual config file updates if configManager not available
        logger.warn(
          "HAProxy config manager not available, using direct file modification"
        );
        return this._updateConfigFileDirectly(
          agentId,
          targetHost,
          targetPort,
          useSsl
        );
      }
    } catch (err) {
      logger.error(`Failed to update MongoDB backend: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });

      return {
        success: false,
        error: `Failed to update MongoDB backend: ${err.message}`,
      };
    }
  }

  /**
   * Fallback method to update HAProxy config file directly if configManager is not available
   * @private
   */
  async _updateConfigFileDirectly(agentId, targetHost, targetPort, useSsl) {
    try {
      // Build the target address
      const targetAddress = `${targetHost}:${targetPort}`;
      logger.info(`Using target address: ${targetAddress}`);

      // Read current configuration
      const configContent = await fs.readFile(this.hostConfigPath, "utf8");
      logger.info(`Read HAProxy configuration from ${this.hostConfigPath}`);

      // Build the server line for this agent
      const serverLine = `    server mongodb-agent-${agentId} ${targetAddress} check`;
      logger.info(`Generated server line: ${serverLine}`);

      // Try to find the mongodb_default backend section
      // We're using a regex that looks for "backend mongodb_default" followed by lines up to the next section
      const backendRegex =
        /backend\s+mongodb_default\s*\n([\s\S]*?)(?=\n\s*\n|\n\s*#|\n\s*backend|\s*$)/;
      const backendMatch = configContent.match(backendRegex);

      // Update the configuration based on what we found
      let updatedConfig;

      if (backendMatch) {
        logger.info("Found existing mongodb_default backend section");

        // Check if the server line already exists for this agent
        const serverRegex = new RegExp(
          `server\\s+mongodb-agent-${agentId}\\s+[^\\n]+`,
          "g"
        );

        if (serverRegex.test(backendMatch[0])) {
          // Server line exists, update it
          updatedConfig = configContent.replace(serverRegex, serverLine);
          logger.info(`Updated existing server line for agent ${agentId}`);
        } else {
          // Server line doesn't exist, add it to the backend
          const updatedBackend = backendMatch[0] + "\n" + serverLine;
          updatedConfig = configContent.replace(
            backendMatch[0],
            updatedBackend
          );
          logger.info(`Added new server line for agent ${agentId}`);
        }
      } else {
        logger.info("mongodb_default backend not found, creating it");

        // Create sections that need to be added or updated
        const mongoFrontend = `
# MongoDB Frontend
frontend mongodb_frontend
    ${
      useSsl
        ? "bind *:27017 ssl crt /etc/ssl/certs/mongodb.pem"
        : "bind *:27017"
    }
    mode tcp
    option tcplog
    ${
      useSsl
        ? "# Extract the agent ID from the SNI hostname for routing\n    http-request set-var(txn.agent_id) req.ssl_sni,field(1,'.')"
        : "# SSL disabled"
    }
    
    # Add enhanced logging for debugging
    log-format "%ci:%cp [%t] %ft %b/%s %Tw/%Tc/%Tt %B %ts %ac/%fc/%bc/%sc/%rc %sq/%bq"
    
    default_backend mongodb_default
`;

        const mongoBackend = `
# MongoDB Backend
backend mongodb_default
    mode tcp
    balance roundrobin
${serverLine}
`;

        // Append to the configuration
        updatedConfig =
          configContent + "\n" + mongoFrontend + "\n" + mongoBackend;
      }

      // Write the updated configuration
      await fs.writeFile(this.hostConfigPath, updatedConfig, "utf8");
      logger.info(`Updated HAProxy configuration for agent ${agentId}`);

      // Update route cache
      this.routeCache.set(`mongo:${agentId}`, {
        name: `mongodb-agent-${agentId}`,
        agentId,
        targetHost,
        targetPort,
        lastUpdated: new Date().toISOString(),
      });

      // Also add to MongoDB servers list
      const existingServerIndex = this.mongoDBServers.findIndex(
        (server) => server.agentId === agentId
      );

      if (existingServerIndex !== -1) {
        this.mongoDBServers[existingServerIndex] = {
          name: `mongodb-agent-${agentId}`,
          agentId,
          address: targetHost,
          port: targetPort,
          lastUpdated: new Date().toISOString(),
        };
      } else {
        this.mongoDBServers.push({
          name: `mongodb-agent-${agentId}`,
          agentId,
          address: targetHost,
          port: targetPort,
          lastUpdated: new Date().toISOString(),
        });
      }

      // Reload HAProxy configuration
      await this._reloadHAProxyConfig();
      logger.info(`HAProxy configuration reloaded for agent ${agentId}`);

      return {
        success: true,
        message: `MongoDB backend for agent ${agentId} updated successfully`,
        useSsl,
        agentId,
        targetHost,
        targetPort,
      };
    } catch (err) {
      logger.error(`Failed to update config file directly: ${err.message}`);
      return {
        success: false,
        error: `Failed to update config file directly: ${err.message}`,
      };
    }
  }

  /**
   * Remove a MongoDB backend server
   *
   * @param {string} agentId - The agent ID
   * @returns {Promise<Object>} Result
   */
  async removeMongoDBBackend(agentId) {
    logger.info(`Removing MongoDB backend for agentId: ${agentId}`);

    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // First, check if the server exists
      const existingServer = this.mongoDBServers.find(
        (server) => server.agentId === agentId
      );

      if (!existingServer) {
        logger.warn(
          `MongoDB server for agent ${agentId} not found, nothing to remove`
        );
        return {
          success: true,
          message: `MongoDB server for agent ${agentId} not found, nothing to remove`,
        };
      }

      // Remove the server from our cached list
      this.mongoDBServers = this.mongoDBServers.filter(
        (server) => server.agentId !== agentId
      );

      // Remove from route cache
      this.routeCache.delete(`mongo:${agentId}`);

      // Use the template-based config manager to update the config
      if (this.configManager) {
        // Check if SSL cert exists
        let useSsl = false;
        let sslCertPath = null;

        try {
          await fs.access("/etc/ssl/certs/mongodb.pem");
          useSsl = true;
          sslCertPath = "/etc/ssl/certs/mongodb.pem";
        } catch (certErr) {
          // No SSL certificate
          logger.debug("SSL certificate not found, disabling SSL");
        }

        // Generate configuration data - includeMongoDB is false if no servers
        const configData = {
          statsPassword: "admin_password",
          includeHttp: true,
          includeMongoDB: this.mongoDBServers.length > 0,
          useSsl,
          sslCertPath,
          mongoDBServers: this.mongoDBServers,
        };

        await this.configManager.saveConfig(configData);
        await this.configManager.applyConfig();

        logger.info(
          `MongoDB backend for agent ${agentId} removed successfully with template-based config`
        );

        return {
          success: true,
          message: `MongoDB backend for agent ${agentId} removed successfully`,
        };
      } else {
        // Fall back to manual config file updates if configManager not available
        logger.warn(
          "HAProxy config manager not available, using direct file modification"
        );
        return this._removeServerDirectly(agentId);
      }
    } catch (err) {
      logger.error(`Failed to remove MongoDB backend: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });

      return {
        success: false,
        error: `Failed to remove MongoDB backend: ${err.message}`,
      };
    }
  }

  /**
   * Fallback method to remove server directly from config file if configManager is not available
   * @private
   */
  async _removeServerDirectly(agentId) {
    try {
      // Read current configuration
      const configContent = await fs.readFile(this.hostConfigPath, "utf8");

      // Create a regex to match the server line for this agent
      const serverLineRegex = new RegExp(
        `\\s*server\\s+mongodb-agent-${agentId}\\s+[^\\n]+\\n?`,
        "g"
      );

      // Remove the server line
      const updatedConfig = configContent.replace(serverLineRegex, "");

      // Write the updated configuration
      await fs.writeFile(this.hostConfigPath, updatedConfig, "utf8");
      logger.info(
        `Removed server line for agent ${agentId} from HAProxy config`
      );

      // Check if the mongodb_default backend is now empty and remove the frontend if needed
      const backendRegex =
        /backend\s+mongodb_default\s*\n([\s\S]*?)(?=\n\s*\n|\n\s*#|\n\s*backend|\s*$)/;
      const backendMatch = updatedConfig.match(backendRegex);

      if (backendMatch && !backendMatch[1].includes("server ")) {
        logger.info(
          "MongoDB backend is empty, removing it in a future update if needed"
        );
        // We could remove the mongodb frontend and backend sections here, but it's safer
        // to keep them and just have an empty backend
      }

      // Reload HAProxy configuration
      await this._reloadHAProxyConfig();
      logger.info(
        `HAProxy configuration reloaded after removing agent ${agentId}`
      );

      return {
        success: true,
        message: `MongoDB backend for agent ${agentId} removed successfully`,
      };
    } catch (err) {
      logger.error(`Failed to remove server directly: ${err.message}`);
      return {
        success: false,
        error: `Failed to remove server directly: ${err.message}`,
      };
    }
  }

  /**
   * Reload HAProxy configuration
   * @private
   */
  async _reloadHAProxyConfig() {
    try {
      logger.info("Reloading HAProxy configuration");

      // Verify configuration before reloading
      const { stderr } = await execAsync(
        `docker exec ${this.haproxyContainer} haproxy -c -f ${this.haproxyConfigPath}`
      );

      if (stderr && stderr.includes("error")) {
        logger.error(`HAProxy configuration is invalid: ${stderr}`);
        throw new Error(`Invalid HAProxy configuration: ${stderr}`);
      }

      // Soft reload HAProxy
      await execAsync(`docker kill -s HUP ${this.haproxyContainer}`);
      logger.info("HAProxy configuration reloaded successfully");

      return {
        success: true,
        message: "HAProxy configuration reloaded successfully",
      };
    } catch (err) {
      logger.error(`Failed to reload HAProxy configuration: ${err.message}`);

      // Try to recover by restarting HAProxy - more disruptive but can sometimes recover
      try {
        logger.warn(
          "Attempting to restart HAProxy container as a recovery action"
        );
        await execAsync(`docker restart ${this.haproxyContainer}`);
        logger.info("HAProxy container restarted successfully");

        return {
          success: true,
          message: "HAProxy configuration reloaded via container restart",
        };
      } catch (restartErr) {
        logger.error(
          `Failed to restart HAProxy container: ${restartErr.message}`
        );
        return {
          success: false,
          error: `Failed to reload HAProxy configuration: ${err.message}. Restart also failed: ${restartErr.message}`,
        };
      }
    }
  }

  /**
   * Get route info for an agent
   * @param {string} agentId - Agent ID
   */
  getRouteInfo(agentId) {
    return this.routeCache.get(`mongo:${agentId}`);
  }

  /**
   * List all routes
   */
  listRoutes() {
    return Array.from(this.routeCache.entries()).map(([key, value]) => ({
      key,
      ...value,
    }));
  }

  /**
   * List all MongoDB servers
   */
  listMongoDBServers() {
    return this.mongoDBServers;
  }

  /**
   * Check if MongoDB port is configured in HAProxy
   * @returns {Promise<Object>} Result of the check
   */
  async checkMongoDBPort() {
    logger.info("Checking MongoDB port configuration");

    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // Check if the MongoDB backend exists
      const { stdout } = await execAsync(
        `docker exec ${this.haproxyContainer} grep -E "\\s*frontend\\s+mongodb_frontend" ${this.haproxyConfigPath}`
      );

      const isConfigured = !!stdout.trim();

      logger.info(
        `MongoDB port configuration check result: ${
          isConfigured ? "Configured" : "Not configured"
        }`
      );

      return {
        success: isConfigured,
        message: isConfigured
          ? "MongoDB port is configured"
          : "MongoDB port is not configured",
      };
    } catch (error) {
      logger.error(`Failed to check MongoDB port: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });

      return {
        success: false,
        error: `Failed to check MongoDB port: ${error.message}`,
      };
    }
  }

  /**
   * Ensure MongoDB port is configured in HAProxy
   * @returns {Promise<Object>} Result of the operation
   */
  async ensureMongoDBPort() {
    logger.info("Ensuring MongoDB port is configured in HAProxy");

    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // First check if already configured
      const checkResult = await this.checkMongoDBPort();

      if (checkResult.success) {
        logger.info("MongoDB port is already configured in HAProxy");
        return {
          success: true,
          message: "MongoDB port is already configured",
        };
      }

      // Use the template-based config manager if available
      if (this.configManager) {
        // Check if SSL cert exists
        let useSsl = false;
        let sslCertPath = null;

        try {
          await fs.access("/etc/ssl/certs/mongodb.pem");
          useSsl = true;
          sslCertPath = "/etc/ssl/certs/mongodb.pem";
          logger.info("MongoDB SSL certificate found, enabling SSL");
        } catch (certErr) {
          // No SSL certificate
          logger.warn("MongoDB SSL certificate not found, disabling SSL");
        }

        // Generate configuration data with empty MongoDB servers list
        const configData = {
          statsPassword: "admin_password",
          includeHttp: true,
          includeMongoDB: true,
          useSsl,
          sslCertPath,
          mongoDBServers: this.mongoDBServers,
        };

        await this.configManager.saveConfig(configData);
        await this.configManager.applyConfig();

        logger.info(
          "MongoDB port configured successfully with template-based config"
        );

        return {
          success: true,
          message: `MongoDB port has been configured in HAProxy${
            useSsl ? " with TLS/SSL support" : " (no SSL)"
          }`,
        };
      } else {
        // Fall back to the direct file update method
        logger.warn(
          "HAProxy config manager not available, using direct file modification"
        );

        // Read current configuration
        const configContent = await fs.readFile(this.hostConfigPath, "utf8");

        // Check if it already contains a mongodb_frontend section
        const hasMongoDB = configContent.includes("frontend mongodb_frontend");

        if (hasMongoDB) {
          logger.info("MongoDB frontend already exists in the configuration");
          return {
            success: true,
            message: "MongoDB frontend already exists",
          };
        }

        // Create MongoDB frontend without TLS/SSL initially (safer default)
        const mongodbFrontend = `
# MongoDB Frontend
frontend mongodb_frontend
    bind *:27017
    mode tcp
    option tcplog
    default_backend mongodb_default

# MongoDB Backend
backend mongodb_default
    mode tcp
    balance roundrobin
`;

        const updatedConfig = configContent + mongodbFrontend;
        await fs.writeFile(this.hostConfigPath, updatedConfig, "utf8");
        logger.info("Added MongoDB frontend to HAProxy configuration (no SSL)");

        // Reload configuration
        await this._reloadHAProxyConfig();
        logger.info(
          "HAProxy configuration reloaded with MongoDB configuration"
        );

        return {
          success: true,
          message: "MongoDB port has been configured in HAProxy (no SSL)",
        };
      }
    } catch (error) {
      logger.error(`Failed to ensure MongoDB port: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });

      return {
        success: false,
        error: `Failed to ensure MongoDB port: ${error.message}`,
      };
    }
  }
}

module.exports = HAProxyManager;
