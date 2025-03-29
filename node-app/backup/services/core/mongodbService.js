/**
 * MongoDB Service
 *
 * Handles MongoDB server management operations:
 * - Registration of agent MongoDB instances
 * - Connection testing
 * - Credential generation
 */

const crypto = require("crypto");
const { MongoClient } = require("mongodb");
const logger = require("../../utils/logger").getLogger("mongodbService");

class MongoDBService {
  constructor(configService, routingService) {
    this.configService = configService;
    this.routingService = routingService;
    this.initialized = false;
    this.mongoDomain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
    this.connectionCache = new Map();
    this.haproxyManager = null; // Will be set during initialize
  }

  /**
   * Initialize the MongoDB service
   * @param {Object} haproxyService - The HAProxy service instance from core/index.js
   */
  async initialize(haproxyService) {
    if (this.initialized) {
      return true;
    }

    try {
      // Set the haproxyManager from the parameter
      if (haproxyService) {
        // For backward compatibility, we use haproxyService parameter but internally store it as haproxyManager
        this.haproxyManager = haproxyService;
        logger.info("HAProxy service reference set successfully");
      } else {
        // Try to dynamically import haproxyManager to avoid circular dependencies
        try {
          const coreServices = require("../core");
          if (coreServices.haproxyManager) {
            this.haproxyManager = coreServices.haproxyManager;
            logger.info("HAProxy manager reference set from core services");
          } else {
            logger.warn("No HAProxy manager found in core services");
          }
        } catch (error) {
          logger.warn("Could not import haproxyManager from core services", {
            error: error.message,
          });
        }

        if (!this.haproxyManager) {
          logger.warn(
            "No HAProxy service provided during initialization, MongoDB routes will not work correctly"
          );
        }
      }

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
        username = "admin",
        password = "adminpassword",
      } = options;

      logger.info(
        `Registering MongoDB agent: ${agentId}, IP: ${targetIp}:${targetPort}`
      );

      // Update HAProxy configuration
      const result = await this.haproxyManager.updateMongoDBBackend(
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
      const domain = `${agentId}.${this.mongoDomain}`;
      const connectionString = `mongodb://${username}:${password}@${domain}:27017/admin?${
        useTls ? "tls=true&tlsAllowInvalidCertificates=true" : ""
      }`;

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

      logger.info(`MongoDB agent ${agentId} registered successfully`);

      return {
        success: true,
        message: `MongoDB agent ${agentId} registered successfully`,
        agentId,
        targetIp,
        targetPort,
        domain,
        mongodbUrl: `mongodb://${domain}:27017`,
        connectionString,
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

      // Remove from HAProxy configuration
      const result = await this.haproxyManager.removeMongoDBBackend(agentId);

      if (!result.success) {
        logger.error(`Failed to remove MongoDB backend: ${result.error}`);
        return {
          success: false,
          error: `Failed to remove MongoDB backend: ${result.error}`,
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
   * Test MongoDB connection
   *
   * @param {string} agentId - Agent ID
   * @param {string} targetIp - Optional override target IP
   * @returns {Promise<Object>} - Test result
   */
  async testConnection(agentId, targetIp = null) {
    let client = null;

    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info(`Testing MongoDB connection for agent ${agentId}`);

      // Get connection info from cache
      const connectionInfo = this.connectionCache.get(agentId);

      if (!connectionInfo && !targetIp) {
        return {
          success: false,
          message: `No connection information found for agent ${agentId}`,
        };
      }

      // Use provided target IP or get from connection cache
      let uri;
      let domain;

      if (connectionInfo) {
        // If we have connection info in cache, use the domain name and stored connection string
        uri = connectionInfo.connectionString;
        domain = connectionInfo.domain;
        logger.info(
          `Using cached connection string for agent ${agentId} with domain ${domain}`
        );
      } else {
        // Fallback to direct IP connection if no cache entry exists
        const host = targetIp;
        const port = 27017;
        domain = `${host}:${port}`;
        uri = `mongodb://admin:adminpassword@${host}:${port}/admin?tls=true&tlsAllowInvalidCertificates=true`;
        logger.info(
          `Using direct IP connection to ${host}:${port} for agent ${agentId}`
        );
      }

      logger.debug(
        `Connecting to MongoDB at ${uri.replace(/:[^:]*@/, ":***@")}`
      );

      // Connect to MongoDB with explicit options
      client = new MongoClient(uri, {
        serverSelectionTimeoutMS: 5000, // 5 seconds timeout
        connectTimeoutMS: 5000,
        socketTimeoutMS: 5000,
        retryWrites: false, // Disable retry writes for diagnosis
        maxPoolSize: 1, // Use minimal connection pool
      });

      logger.info(`Attempting to connect to MongoDB at ${domain}...`);
      await client.connect();

      if (!client) {
        throw new Error("MongoDB client is null after connection attempt");
      }

      logger.info(
        `Connected to MongoDB at ${domain}, testing admin database...`
      );
      const adminDb = client.db("admin");

      if (!adminDb) {
        throw new Error("Failed to get admin database");
      }

      logger.info(`Admin database accessed, sending ping command...`);
      const pingResult = await adminDb.command({ ping: 1 });

      logger.info(
        `MongoDB connection test successful for agent ${agentId}, ping result:`,
        pingResult
      );

      return {
        success: true,
        message: "MongoDB connection test successful",
        result: pingResult,
      };
    } catch (error) {
      logger.error(
        `MongoDB connection test failed for agent ${agentId}: ${error.message}`,
        {
          error: error.message,
          stack: error.stack,
        }
      );

      return {
        success: false,
        message: `MongoDB connection test failed: ${error.message}`,
      };
    } finally {
      // Ensure client is closed if it was created successfully
      if (client) {
        try {
          await client.close();
          logger.debug(`MongoDB client closed for agent ${agentId}`);
        } catch (closeError) {
          logger.warn(`Error closing MongoDB client: ${closeError.message}`);
        }
      }
    }
  }

  /**
   * Get connection information for a MongoDB agent
   *
   * @param {string} agentId - Agent ID
   * @returns {Promise<Object|null>} - Connection information or null if not found
   */
  async getConnectionInfo(agentId) {
    if (!this.initialized) {
      await this.initialize();
    }

    // Get connection info from cache
    const connectionInfo = this.connectionCache.get(agentId);

    if (!connectionInfo) {
      return null;
    }

    return connectionInfo;
  }

  /**
   * Generate credentials for a MongoDB database
   *
   * @param {string} agentId - Agent ID
   * @param {string} dbName - Database name
   * @param {string} username - Optional username (will be generated if not provided)
   * @returns {Promise<Object>} - Generated credentials
   */
  async generateCredentials(agentId, dbName, username = null) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      // Get connection info from cache
      const connectionInfo = this.connectionCache.get(agentId);

      if (!connectionInfo) {
        return {
          success: false,
          error: `No connection information found for agent ${agentId}`,
        };
      }

      // Generate username if not provided
      const dbUsername =
        username || `user_${dbName}_${Math.floor(Math.random() * 10000)}`;

      // Generate a secure random password
      const password = crypto.randomBytes(16).toString("hex");

      // Build connection string
      const { domain, useTls } = connectionInfo;
      const connectionString = `mongodb://${dbUsername}:${password}@${domain}:27017/${dbName}?${
        useTls ? "tls=true&tlsAllowInvalidCertificates=true" : ""
      }`;

      logger.info(
        `Generated credentials for database ${dbName} on agent ${agentId}`
      );

      return {
        success: true,
        username: dbUsername,
        password,
        connectionString,
        dbName,
      };
    } catch (error) {
      logger.error(`Error generating credentials: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });

      return {
        success: false,
        error: `Error generating credentials: ${error.message}`,
      };
    }
  }
}

// Export the class instead of an instance to match how it's used in core/index.js
module.exports = MongoDBService;
