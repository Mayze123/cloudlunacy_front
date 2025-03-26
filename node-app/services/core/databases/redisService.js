/**
 * Redis Service
 *
 * Handles Redis server management operations:
 * - Registration of agent Redis instances
 * - Connection testing
 * - Configuration management
 */

const crypto = require("crypto");
const { createClient } = require("redis");
const logger = require("../../../utils/logger").getLogger("redisService");
const DatabaseService = require("./databaseService");

class RedisService extends DatabaseService {
  constructor(routingService, haproxyManager) {
    super(routingService);
    this.redisDomain = process.env.REDIS_DOMAIN || "redis.cloudlunacy.uk";
    this.connectionCache = new Map();
    this.haproxyManager = haproxyManager;
  }

  /**
   * Initialize the Redis service
   */
  async initialize() {
    if (this.initialized) {
      return true;
    }

    try {
      if (!this.haproxyManager) {
        logger.warn(
          "No HAProxy manager provided during initialization, Redis routes will not work correctly"
        );
      }

      this.initialized = true;
      logger.info("Redis service initialized");
      return true;
    } catch (error) {
      logger.error(`Failed to initialize Redis service: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });
      return false;
    }
  }

  /**
   * Register a Redis agent
   *
   * @param {string} agentId - Agent ID
   * @param {string} targetIp - Target IP address
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} - Registration result
   */
  async registerAgent(agentId, targetIp, options = {}) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      // Default options
      const { useTls = true, targetPort = 6379, password = null } = options;

      logger.info(
        `Registering Redis agent: ${agentId}, IP: ${targetIp}:${targetPort}`
      );

      if (!this.haproxyManager) {
        return {
          success: false,
          error: "HAProxy manager not available",
        };
      }

      // Update HAProxy configuration for Redis - we'll assume a method is implemented or will be
      const result = await this.haproxyManager.updateRedisBackend(
        agentId,
        targetIp,
        targetPort
      );

      if (!result.success) {
        logger.error(`Failed to update HAProxy backend: ${result.error}`);
        return {
          success: false,
          error: `Failed to update HAProxy backend: ${result.error}`,
        };
      }

      // Build connection information
      const domain = `${agentId}.${this.redisDomain}`;
      const connectionString = `redis${useTls ? "s" : ""}://${
        password ? `default:${password}@` : ""
      }${domain}:6379`;

      // Cache the connection info
      this.connectionCache.set(agentId, {
        agentId,
        targetIp,
        targetPort,
        domain,
        connectionString,
        useTls,
        lastUpdated: new Date().toISOString(),
      });

      logger.info(`Redis agent ${agentId} registered successfully`);

      return {
        success: true,
        message: `Redis agent ${agentId} registered successfully`,
        agentId,
        targetIp,
        targetPort,
        domain,
        redisUrl: `redis://${domain}:6379`,
        connectionString,
      };
    } catch (error) {
      logger.error(`Error registering Redis agent: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });

      return {
        success: false,
        error: `Error registering Redis agent: ${error.message}`,
      };
    }
  }

  /**
   * Deregister a Redis agent
   *
   * @param {string} agentId - Agent ID
   * @returns {Promise<Object>} - Deregistration result
   */
  async deregisterAgent(agentId) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info(`Deregistering Redis agent: ${agentId}`);

      if (!this.haproxyManager) {
        return {
          success: false,
          error: "HAProxy manager not available",
        };
      }

      // Remove from HAProxy configuration
      const result = await this.haproxyManager.removeRedisBackend(agentId);

      if (!result.success) {
        logger.error(`Failed to remove Redis backend: ${result.error}`);
        return {
          success: false,
          error: `Failed to remove Redis backend: ${result.error}`,
        };
      }

      // Remove from connection cache
      this.connectionCache.delete(agentId);

      logger.info(`Redis agent ${agentId} deregistered successfully`);

      return {
        success: true,
        message: `Redis agent ${agentId} deregistered successfully`,
      };
    } catch (error) {
      logger.error(`Error deregistering Redis agent: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });

      return {
        success: false,
        error: `Error deregistering Redis agent: ${error.message}`,
      };
    }
  }

  /**
   * Test connection to a Redis instance
   *
   * @param {string} agentId - Agent ID
   * @param {string} targetIp - Target IP (optional, uses cached value if not provided)
   * @returns {Promise<Object>} - Test result
   */
  async testConnection(agentId, targetIp = null) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info(`Testing Redis connection for agent: ${agentId}`);

      // Get connection info from cache or use the targetIp if provided
      let connectionInfo;
      if (this.connectionCache.has(agentId)) {
        connectionInfo = this.connectionCache.get(agentId);
        logger.debug(`Using cached connection info for ${agentId}`);
      } else if (targetIp) {
        // Create temporary connection info
        connectionInfo = {
          agentId,
          targetIp,
          targetPort: 6379, // Default Redis port
          domain: `${agentId}.${this.redisDomain}`,
          useTls: false,
        };
        logger.debug(`Created temporary connection info for ${agentId}`);
      } else {
        logger.error(
          `No connection info available for agent ${agentId} and no targetIp provided`
        );
        return {
          success: false,
          error: "No connection information available",
        };
      }

      // Attempt direct connection to the Redis instance
      let directClient = null;
      try {
        const directUrl = `redis://${connectionInfo.targetIp}:${connectionInfo.targetPort}`;
        logger.debug(`Attempting direct connection to ${directUrl}`);

        directClient = createClient({
          url: directUrl,
          socket: {
            connectTimeout: 5000,
          },
        });

        // Connect and ping to verify
        await directClient.connect();
        const pingResponse = await directClient.ping();

        logger.info(
          `Direct Redis connection successful to ${connectionInfo.targetIp}, ping: ${pingResponse}`
        );

        return {
          success: true,
          message: "Redis connection test successful",
          direct: {
            success: true,
            pingResponse,
          },
          proxy: {
            // Not testing proxy connection here for simplicity
            success: null,
            message: "Proxy connection test not performed",
          },
        };
      } catch (directError) {
        logger.error(`Direct Redis connection failed: ${directError.message}`);

        return {
          success: false,
          error: `Redis connection test failed: ${directError.message}`,
          direct: {
            success: false,
            error: directError.message,
          },
          proxy: {
            success: null,
            message: "Proxy connection test not performed",
          },
        };
      } finally {
        if (directClient && directClient.isOpen) {
          await directClient.disconnect();
        }
      }
    } catch (error) {
      logger.error(`Error testing Redis connection: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });

      return {
        success: false,
        error: `Error testing Redis connection: ${error.message}`,
      };
    }
  }

  /**
   * Get connection information for a Redis agent
   *
   * @param {string} agentId - Agent ID
   * @returns {Promise<Object>} - Connection information
   */
  async getConnectionInfo(agentId) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      if (!this.connectionCache.has(agentId)) {
        logger.error(`No connection info available for agent ${agentId}`);
        return {
          success: false,
          error: "No connection information available for this agent",
        };
      }

      const connectionInfo = this.connectionCache.get(agentId);
      return {
        success: true,
        message: "Connection information retrieved successfully",
        ...connectionInfo,
      };
    } catch (error) {
      logger.error(`Error getting connection info: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });

      return {
        success: false,
        error: `Error getting connection info: ${error.message}`,
      };
    }
  }

  /**
   * Generate authentication for Redis access
   *
   * @param {string} agentId - Agent ID
   * @param {string} username - Username (default is "default" for Redis 6+)
   * @returns {Promise<Object>} - Generated credentials
   */
  async generateCredentials(agentId, _dbName = null, username = "default") {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      // Generate secure password
      const password = crypto.randomBytes(16).toString("hex");

      // Create connection string with the new credentials
      const domain = `${agentId}.${this.redisDomain}`;
      const connectionString = `redis://${username}:${password}@${domain}:6379`;

      // Get connection info from cache if available
      const connectionInfo = this.connectionCache.get(agentId) || {
        targetIp: "localhost",
        targetPort: 6379,
      };

      logger.info(`Generated Redis credentials for ${agentId}`);

      return {
        success: true,
        message: "Redis credentials generated successfully",
        agentId,
        username,
        password,
        connectionString,
        uri: `redis://${domain}:6379`,
        instructions: [
          "To set this password in Redis, run:",
          `redis-cli -h ${connectionInfo.targetIp} -p ${connectionInfo.targetPort}`,
          `CONFIG SET requirepass "${password}"`,
        ],
      };
    } catch (error) {
      logger.error(`Error generating Redis credentials: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });

      return {
        success: false,
        error: `Error generating Redis credentials: ${error.message}`,
      };
    }
  }
}

module.exports = RedisService;
