/**
 * MongoDB Service
 *
 * Handles MongoDB server management operations:
 * - Registration of agent MongoDB instances
 * - Connection testing
 */

const crypto = require("crypto");
const { MongoClient } = require("mongodb");
const logger = require("../../../utils/logger").getLogger("mongodbService");
const DatabaseService = require("./databaseService");

class MongoDBService extends DatabaseService {
  constructor(routingService, traefikService) {
    super(routingService);
    this.mongoDomain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
    this.connectionCache = new Map();
    this.traefikService = traefikService;
    // Cache expiration time in milliseconds (default: 1 hour)
    this.cacheExpirationTime = process.env.MONGO_CACHE_EXPIRATION || 3600000;
  }

  /**
   * Initialize the MongoDB service
   */
  async initialize() {
    if (this.initialized) {
      return true;
    }

    try {
      if (!this.traefikService) {
        logger.warn(
          "Traefik service not available during initialization, MongoDB routes will not work correctly"
        );
      }

      // Start a background task to clean expired cache entries
      this._startCacheCleanupTask();

      this.initialized = true;
      logger.info("MongoDB service initialized");
      return true;
    } catch (error) {
      logger.error(`Failed to initialize MongoDB service: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });
      return false;
    }
  }

  /**
   * Start a periodic task to clean up expired cache entries
   * @private
   */
  _startCacheCleanupTask() {
    // Run cache cleanup every hour
    const cleanupInterval = Math.min(this.cacheExpirationTime, 3600000);
    
    setInterval(() => {
      try {
        const now = Date.now();
        let cleanupCount = 0;
        
        this.connectionCache.forEach((value, key) => {
          if (value.lastUpdated) {
            const lastUpdatedTime = new Date(value.lastUpdated).getTime();
            if (now - lastUpdatedTime > this.cacheExpirationTime) {
              this.connectionCache.delete(key);
              cleanupCount++;
            }
          }
        });
        
        if (cleanupCount > 0) {
          logger.debug(`Cleaned up ${cleanupCount} expired MongoDB connection cache entries`);
        }
      } catch (error) {
        logger.error(`Error in MongoDB cache cleanup: ${error.message}`);
      }
    }, cleanupInterval);
  }

  /**
   * Register a MongoDB agent
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
      const {
        useTls = true,
        targetPort = 27017,
      } = options;

      logger.info(
        `Registering MongoDB agent: ${agentId}, IP: ${targetIp}:${targetPort}`
      );

      if (!this.traefikService) {
        return {
          success: false,
          error: "Traefik service not available",
        };
      }

      let routingResult;
      // Use Traefik for routing
      if (typeof this.traefikService.addMongoDBRoute === "function") {
        try {
          routingResult = await this.traefikService.addMongoDBRoute(
            agentId,
            targetIp,
            targetPort,
            { useTls }
          );
          if (!routingResult.success) {
            return {
              success: false,
              error: `Failed to update Traefik: ${routingResult.error || "Unknown error"}`,
            };
          }
          logger.info(`Successfully updated Traefik for MongoDB agent ${agentId}`);
        } catch (traefikErr) {
          logger.error(`Failed to use Traefik: ${traefikErr.message}`);
          return {
            success: false,
            error: `Failed to update Traefik: ${traefikErr.message}`,
          };
        }
      } else {
        logger.error("Traefik service does not support addMongoDBRoute method");
        return {
          success: false,
          error: "Traefik service does not support MongoDB routes",
        };
      }

      // Build connection information with proper TLS options
      const domain = `${agentId}.${this.mongoDomain}`;
      
      // Cache the connection info with expiration timestamp
      const now = new Date().toISOString();
      this.connectionCache.set(agentId, {
        agentId,
        targetIp,
        targetPort,
        domain,
        useTls,
        routingService: "traefik",
        lastUpdated: now,
        created: now
      });

      logger.info(`MongoDB agent ${agentId} registered successfully using Traefik`);

      return {
        success: true,
        message: `MongoDB agent ${agentId} registered successfully`,
        agentId,
        targetIp,
        targetPort,
        domain,
        mongodbUrl: `mongodb://${domain}:27017`,
        routingService: "traefik"
      };
    } catch (error) {
      logger.error(`Error registering MongoDB agent: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });

      return {
        success: false,
        error: `Error registering MongoDB agent: ${error.message}`,
      };
    }
  }

  /**
   * Deregister a MongoDB agent
   *
   * @param {string} agentId - Agent ID
   * @returns {Promise<Object>} - Deregistration result
   */
  async deregisterAgent(agentId) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info(`Deregistering MongoDB agent: ${agentId}`);

      if (!this.traefikService) {
        return {
          success: false,
          error: "Traefik service not available",
        };
      }

      // Remove from Traefik configuration
      try {
        if (typeof this.traefikService.removeRoute === "function") {
          await this.traefikService.removeRoute(agentId, null, "mongodb");
          logger.info(`MongoDB route for ${agentId} removed from Traefik`);
        } else {
          logger.warn("Traefik service does not support MongoDB route removal");
          return {
            success: false,
            error: "Traefik service does not support MongoDB route removal",
          };
        }
      } catch (traefikErr) {
        logger.error(`Failed to remove MongoDB backend: ${traefikErr.message}`);
        return {
          success: false,
          error: `Failed to remove MongoDB backend: ${traefikErr.message}`,
        };
      }

      // Remove from connection cache
      this.connectionCache.delete(agentId);

      logger.info(`MongoDB agent ${agentId} deregistered successfully`);

      return {
        success: true,
        message: `MongoDB agent ${agentId} deregistered successfully`,
      };
    } catch (error) {
      logger.error(`Error deregistering MongoDB agent: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });

      return {
        success: false,
        error: `Error deregistering MongoDB agent: ${error.message}`,
      };
    }
  }

  /**
   * Test connection to a MongoDB instance
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

      logger.info(`Testing MongoDB connection for agent: ${agentId}`);

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
          targetPort: 27017, // Default MongoDB port
          domain: `${agentId}.${this.mongoDomain}`,
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

      // Attempt direct connection to the MongoDB instance
      let directClient = null;
      let proxyClient = null;
      const result = {
        success: false,
        direct: { success: false },
        proxy: { success: false }
      };

      // First test direct connection
      try {
        const directUrl = `mongodb://${connectionInfo.targetIp}:${connectionInfo.targetPort}`;
        logger.debug(`Attempting direct connection to ${directUrl}`);

        directClient = new MongoClient(directUrl, {
          connectTimeoutMS: 5000,
          serverSelectionTimeoutMS: 5000,
        });

        await directClient.connect();
        const adminDb = directClient.db("admin");
        const serverInfo = await adminDb.command({ serverStatus: 1 });

        logger.info(
          `Direct MongoDB connection successful to ${connectionInfo.targetIp}`
        );

        result.direct = {
          success: true,
          serverVersion: serverInfo.version,
          uptime: serverInfo.uptime
        };
        
        // Set overall success to true if direct connection succeeds
        result.success = true;
      } catch (directError) {
        logger.error(`Direct MongoDB connection failed: ${directError.message}`);
        result.direct = {
          success: false,
          error: directError.message
        };
      } finally {
        if (directClient) {
          await directClient.close().catch(() => {});
        }
      }

      // Then test proxy connection if we have full connection info
      if (connectionInfo.domain) {
        try {
          // Create a test connection string with anonymous credentials
          // This just tests TCP connectivity, not actual authentication
          let proxyUrl = `mongodb://anon:anon@${connectionInfo.domain}:27017/admin?authSource=admin`;
          
          // Add TLS options if needed
          if (connectionInfo.useTls) {
            proxyUrl += "&tls=true&tlsAllowInvalidCertificates=true";
          }
          
          logger.debug(`Attempting proxy connection to ${proxyUrl.replace(/anon:anon/, "anon:***")}`);

          proxyClient = new MongoClient(proxyUrl, {
            connectTimeoutMS: 5000,
            serverSelectionTimeoutMS: 5000,
          });
          
          // Just attempt to connect - we expect auth to fail but TCP connection to succeed
          await proxyClient.connect();
          
          // If we somehow get here without error, connection worked (unlikely with dummy credentials)
          result.proxy = {
            success: true,
            message: "Proxy connection successful - TCP connectivity verified"
          };
        } catch (proxyError) {
          // Check if it's an authentication error (which means routing works)
          if (proxyError.message.includes("Authentication failed") || 
              proxyError.code === 18 || // AuthenticationFailed code
              proxyError.message.includes("not authorized")) {
            // Auth failed but TCP connection succeeded - this is actually good!
            result.proxy = {
              success: true,
              message: "Proxy routing verified (auth failed but TCP connection succeeded)"
            };
          } else {
            // This is a real connection failure
            logger.error(`Proxy MongoDB connection failed: ${proxyError.message}`);
            result.proxy = {
              success: false,
              error: proxyError.message
            };
          }
        } finally {
          if (proxyClient) {
            await proxyClient.close().catch(() => {});
          }
        }
      } else {
        result.proxy = {
          success: null,
          message: "Proxy connection test skipped - insufficient connection information"
        };
      }

      // Set overall success - successful if either direct or proxy connection worked
      result.success = result.direct.success || (result.proxy && result.proxy.success);
      
      if (result.success) {
        result.message = "MongoDB connection test partially or fully successful";
      } else {
        result.error = "MongoDB connection test failed for both direct and proxy connections";
      }

      return result;
    } catch (error) {
      logger.error(`Error testing MongoDB connection: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });

      return {
        success: false,
        error: `Error testing MongoDB connection: ${error.message}`,
      };
    }
  }

  /**
   * Get connection information for a MongoDB agent
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
   * Check if MongoDB port is available
   * @returns {Promise<boolean>} True if MongoDB port configuration is ok
   */
  async checkMongoDBPort() {
    try {
      if (!this.traefikService) {
        logger.warn("Traefik service not available, cannot check MongoDB port");
        return false;
      }

      // Check if the Traefik service has a health check method
      if (typeof this.traefikService.performHealthCheck === "function") {
        const health = await this.traefikService.performHealthCheck();
        return health && health.containerRunning;
      }

      // Fallback to querying the service health
      if (typeof this.traefikService.getHealthStatus === "function") {
        const healthStatus = await this.traefikService.getHealthStatus();
        return healthStatus && healthStatus.status === "healthy";
      }

      logger.warn("Traefik service does not support health checking");
      return false;
    } catch (error) {
      logger.error(`Error checking MongoDB port: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });
      return false;
    }
  }

  /**
   * Ensure MongoDB port is configured in Traefik
   * @returns {Promise<boolean>} True if configuration was successful
   */
  async ensureMongoDBPort() {
    try {
      if (!this.traefikService) {
        logger.warn(
          "Traefik service not available, cannot ensure MongoDB port"
        );
        return false;
      }

      // Check if the service is healthy
      const healthStatus = await this.checkMongoDBPort();

      if (!healthStatus) {
        // Try to recover the service
        if (typeof this.traefikService.recoverService === "function") {
          const recovery = await this.traefikService.recoverService();
          return recovery && recovery.success;
        }
      }

      return healthStatus;
    } catch (error) {
      logger.error(`Error ensuring MongoDB port: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });
      return false;
    }
  }
}

module.exports = MongoDBService;
