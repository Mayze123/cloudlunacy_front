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

      // Load existing configuration
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
    // Clear route cache
    this.routeCache.clear();

    try {
      // Extract mongodb backend information
      const backendRegex = /backend\s+mongodb-backend-dyn\s*{[\s\S]*?}/g;
      const backendMatch = configContent.match(backendRegex);

      if (backendMatch) {
        // Extract server lines
        const serverRegex = /server\s+mongodb-agent\s+([^\s]+)\s+/g;
        let serverMatch;

        while ((serverMatch = serverRegex.exec(backendMatch[0])) !== null) {
          const targetAddress = serverMatch[1];

          // Add to route cache
          this.routeCache.set("tcp:mongodb", {
            name: "mongodb-backend-dyn",
            targetAddress,
            lastUpdated: new Date().toISOString(),
          });

          logger.info(`Found MongoDB backend with target: ${targetAddress}`);
        }
      }

      logger.info(
        `Loaded ${this.routeCache.size} routes from HAProxy configuration`
      );
      return true;
    } catch (err) {
      logger.error(`Failed to parse HAProxy configuration: ${err.message}`);
      throw err;
    }
  }

  /**
   * Update HAProxy MongoDB backend server
   *
   * @param {string} agentId - The agent ID
   * @param {string} targetHost - Target host
   * @param {number} targetPort - Target port (default: 27017)
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

      if (!backendMatch) {
        logger.error(
          "mongodb_default backend not found in HAProxy configuration"
        );

        // Dump the config for debugging
        logger.debug(
          `HAProxy config content: ${configContent.substring(0, 500)}...`
        );

        // Create the mongodb_default backend if it doesn't exist
        const newBackend = `\n# MongoDB Backend for ${agentId}\nbackend mongodb_default\n    mode tcp\n${serverLine}\n`;
        const updatedConfig = configContent + newBackend;

        await fs.writeFile(this.hostConfigPath, updatedConfig, "utf8");
        logger.info(
          "Created new mongodb_default backend in HAProxy configuration"
        );

        // Update route cache
        this.routeCache.set(`tcp:${agentId}`, {
          name: "mongodb_default",
          agentId,
          targetAddress,
          lastUpdated: new Date().toISOString(),
        });

        // Reload HAProxy configuration
        await this._reloadHAProxyConfig();
        logger.info(
          "HAProxy configuration with new backend reloaded successfully"
        );

        return {
          success: true,
          agentId,
          targetAddress,
          message: `Created new HAProxy mongodb_default backend for agent: ${agentId}`,
        };
      }

      // Extract the content of the mongodb_default backend
      const backendContent = backendMatch[0];
      logger.info(`Found mongodb_default backend: ${backendContent.trim()}`);

      // Check if this agent already has a server line
      const agentServerRegex = new RegExp(
        `server\\s+mongodb-agent-${agentId}\\s+.*`,
        "m"
      );
      const existingServerLine = backendContent.match(agentServerRegex);

      let updatedConfig;
      if (existingServerLine) {
        // Replace the existing server line
        updatedConfig = configContent.replace(agentServerRegex, serverLine);
        logger.info(`Replaced existing server line for agent ${agentId}`);
      } else {
        // Add a new server line to the backend section
        const lastLine = backendContent.trim().split("\n").pop();
        const updatedBackend = backendContent.replace(
          lastLine,
          `${lastLine}\n${serverLine}`
        );
        updatedConfig = configContent.replace(backendContent, updatedBackend);
        logger.info(`Added new server line for agent ${agentId}`);
      }

      // Write updated configuration
      await fs.writeFile(this.hostConfigPath, updatedConfig, "utf8");
      logger.info(
        `Updated HAProxy configuration written to ${this.hostConfigPath}`
      );

      // Update route cache
      this.routeCache.set(`tcp:${agentId}`, {
        name: "mongodb_default",
        agentId,
        targetAddress,
        lastUpdated: new Date().toISOString(),
      });
      logger.info(`Added route to cache for agentId: ${agentId}`);

      // Reload HAProxy configuration
      await this._reloadHAProxyConfig();
      logger.info("HAProxy configuration reloaded successfully");

      return {
        success: true,
        agentId,
        targetAddress,
        message: `HAProxy configuration updated for agentId: ${agentId}`,
      };
    } catch (err) {
      logger.error(`Failed to update MongoDB backend: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });

      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Remove MongoDB backend for an agent
   *
   * @param {string} agentId - The agent ID
   * @returns {Promise<Object>} Result object
   */
  async removeMongoDBBackend(agentId) {
    logger.info(`Removing MongoDB backend for agentId: ${agentId}`);

    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // We don't actually remove the server line from HAProxy config
      // since we use a dynamic backend approach with agent_id variable.
      // We just remove the route from our cache.

      // Check if route exists
      if (!this.routeCache.has(`tcp:${agentId}`)) {
        return {
          success: false,
          error: `MongoDB backend for agentId ${agentId} not found`,
        };
      }

      // Remove route from cache
      this.routeCache.delete(`tcp:${agentId}`);

      // No need to reload HAProxy since the config didn't change
      // The SNI routing will simply not match for this agent ID anymore

      return {
        success: true,
        message: `MongoDB backend for agentId ${agentId} removed successfully`,
      };
    } catch (err) {
      logger.error(`Failed to remove MongoDB backend: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });

      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Reload HAProxy configuration
   */
  async _reloadHAProxyConfig() {
    try {
      // Reload HAProxy configuration with SIGUSR2 signal
      const { stdout } = await execAsync(
        `docker kill --signal=SIGUSR2 ${this.haproxyContainer}`
      );
      logger.info(`HAProxy configuration reloaded: ${stdout}`);
      return true;
    } catch (err) {
      logger.error(`Failed to reload HAProxy configuration: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get route information
   *
   * @param {string} agentId - The agent ID
   */
  getRouteInfo(agentId) {
    return this.routeCache.get(`tcp:${agentId}`);
  }

  /**
   * List all routes
   */
  listRoutes() {
    return Array.from(this.routeCache.entries()).map(([key, route]) => ({
      key,
      ...route,
    }));
  }

  /**
   * Update HAProxy Redis backend server
   *
   * @param {string} agentId - The agent ID
   * @param {string} targetHost - Target host
   * @param {number} targetPort - Target port (default: 6379)
   */
  async updateRedisBackend(agentId, targetHost, targetPort = 6379) {
    logger.info(
      `Updating Redis backend for agentId: ${agentId}, target: ${targetHost}:${targetPort}`
    );

    if (!this.initialized) {
      logger.info("HAProxy manager not initialized, initializing now...");
      await this.initialize();
    }

    try {
      // Build the target address
      const targetAddress = `${targetHost}:${targetPort}`;
      logger.info(`Using target address: ${targetAddress}`);

      // Read current configuration
      const configContent = await fs.readFile(this.hostConfigPath, "utf8");
      logger.info(`Read HAProxy configuration from ${this.hostConfigPath}`);

      // Build the server line for this agent
      const serverLine = `    server redis-agent-${agentId} ${targetAddress} check`;
      logger.info(`Generated server line: ${serverLine}`);

      // Try to find the redis_default backend section
      const backendRegex =
        /backend\s+redis_default\s*\n([\s\S]*?)(?=\n\s*\n|\n\s*#|\n\s*backend|\s*$)/;
      const backendMatch = configContent.match(backendRegex);

      let updatedConfig;

      if (!backendMatch) {
        logger.info("redis_default backend not found, creating it");
        // Create the redis_default backend if it doesn't exist
        const newBackend = `\n# Redis Backend for ${agentId}\nbackend redis_default\n    mode tcp\n${serverLine}\n`;
        updatedConfig = configContent + newBackend;

        // Also need to ensure we have a frontend for Redis
        if (!configContent.includes("frontend redis-in")) {
          logger.info("Creating Redis frontend section");
          const redisFrontend =
            "\n# Redis Frontend\nfrontend redis-in\n    bind *:6379\n    mode tcp\n    default_backend redis_default\n";
          updatedConfig = updatedConfig + redisFrontend;
        }
      } else {
        logger.info("Found redis_default backend, updating it");
        // Check if this agent already has a server line
        const agentServerRegex = new RegExp(
          `server\\s+redis-agent-${agentId}\\s+[^\\s]+\\s+check`,
          "g"
        );
        const agentMatch = backendMatch[1].match(agentServerRegex);

        if (agentMatch) {
          // Update existing server line
          logger.info(`Updating existing server line for agent ${agentId}`);
          updatedConfig = configContent.replace(agentServerRegex, serverLine);
        } else {
          // Add server line to existing backend
          logger.info(`Adding new server line for agent ${agentId}`);
          const updatedBackend = backendMatch[0] + `\n${serverLine}`;
          updatedConfig = configContent.replace(
            backendMatch[0],
            updatedBackend
          );
        }
      }

      // Write updated configuration
      await fs.writeFile(this.hostConfigPath, updatedConfig, "utf8");
      logger.info(
        `Updated HAProxy configuration with Redis backend for ${agentId}`
      );

      // Reload HAProxy configuration
      await this._reloadHAProxyConfig();

      // Update route cache
      this.routeCache.set(`tcp:redis:${agentId}`, {
        name: "redis_default",
        agentId,
        targetAddress,
        lastUpdated: new Date().toISOString(),
      });

      return {
        success: true,
        message: `Redis backend updated for agent ${agentId}`,
      };
    } catch (error) {
      logger.error(`Failed to update Redis backend: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });
      return {
        success: false,
        error: `Failed to update Redis backend: ${error.message}`,
      };
    }
  }

  /**
   * Remove Redis backend server for specific agent
   *
   * @param {string} agentId - The agent ID to remove
   * @returns {Promise<Object>} - Result
   */
  async removeRedisBackend(agentId) {
    logger.info(`Removing Redis backend for agentId: ${agentId}`);

    if (!this.initialized) {
      logger.info("HAProxy manager not initialized, initializing now...");
      await this.initialize();
    }

    try {
      // Read current configuration
      const configContent = await fs.readFile(this.hostConfigPath, "utf8");

      // Find the server line for this agent
      const serverRegex = new RegExp(
        `\\s*server\\s+redis-agent-${agentId}\\s+[^\\n]+\\n`,
        "g"
      );

      // Check if the pattern exists in the configuration
      if (!serverRegex.test(configContent)) {
        logger.info(`No Redis backend found for agent ${agentId}`);
        return {
          success: true,
          message: `No Redis backend found for agent ${agentId}`,
        };
      }

      // Remove the server line
      const updatedConfig = configContent.replace(serverRegex, "\n");

      // Write updated configuration
      await fs.writeFile(this.hostConfigPath, updatedConfig, "utf8");
      logger.info(
        `Removed Redis backend for agent ${agentId} from HAProxy configuration`
      );

      // Reload HAProxy configuration
      await this._reloadHAProxyConfig();

      // Update route cache
      this.routeCache.delete(`tcp:redis:${agentId}`);

      return {
        success: true,
        message: `Redis backend removed for agent ${agentId}`,
      };
    } catch (error) {
      logger.error(`Failed to remove Redis backend: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });
      return {
        success: false,
        error: `Failed to remove Redis backend: ${error.message}`,
      };
    }
  }

  /**
   * Check if Redis port is configured in HAProxy
   * @returns {Promise<Object>} - Result
   */
  async checkRedisPort() {
    logger.info("Checking Redis port configuration");

    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // Read current configuration
      const configContent = await fs.readFile(this.hostConfigPath, "utf8");

      // Check if Redis frontend exists
      const redisFrontendExists = configContent.includes("frontend redis-in");

      return {
        success: redisFrontendExists,
        message: redisFrontendExists
          ? "Redis port is configured in HAProxy"
          : "Redis port is not configured in HAProxy",
      };
    } catch (error) {
      logger.error(`Failed to check Redis port: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });
      return {
        success: false,
        error: `Failed to check Redis port: ${error.message}`,
      };
    }
  }

  /**
   * Ensure Redis port is configured in HAProxy
   * @returns {Promise<Object>} - Result
   */
  async ensureRedisPort() {
    logger.info("Ensuring Redis port is configured");

    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // Check current configuration
      const checkResult = await this.checkRedisPort();

      if (checkResult.success) {
        logger.info("Redis port already configured in HAProxy");
        return checkResult;
      }

      // Read current configuration
      const configContent = await fs.readFile(this.hostConfigPath, "utf8");

      // Add Redis frontend and backend
      const redisConfig = `
# Redis Frontend
frontend redis-in
    bind *:6379
    mode tcp
    default_backend redis_default

# Redis Backend
backend redis_default
    mode tcp
`;

      // Update configuration
      const updatedConfig = configContent + redisConfig;
      await fs.writeFile(this.hostConfigPath, updatedConfig, "utf8");

      // Reload HAProxy configuration
      await this._reloadHAProxyConfig();

      logger.info("Redis port configured successfully");
      return {
        success: true,
        message: "Redis port configured successfully in HAProxy",
      };
    } catch (error) {
      logger.error(`Failed to ensure Redis port: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });
      return {
        success: false,
        error: `Failed to ensure Redis port: ${error.message}`,
      };
    }
  }
}

module.exports = HAProxyManager;
