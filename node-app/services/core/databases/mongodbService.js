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
const logger = require("../../../utils/logger").getLogger("mongodbService");
const DatabaseService = require("./databaseService");

class MongoDBService extends DatabaseService {
  constructor(routingService, haproxyManager) {
    super(routingService);
    this.mongoDomain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
    this.connectionCache = new Map();
    this.haproxyManager = haproxyManager;
  }

  /**
   * Initialize the MongoDB service
   */
  async initialize() {
    if (this.initialized) {
      return true;
    }

    try {
      if (!this.haproxyManager) {
        logger.warn(
          "No HAProxy manager provided during initialization, MongoDB routes will not work correctly"
        );
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

      if (!this.haproxyManager) {
        return {
          success: false,
          error: "HAProxy manager not available",
        };
      }

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

      if (!this.haproxyManager) {
        return {
          success: false,
          error: "HAProxy manager not available",
        };
      }

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

        return {
          success: true,
          message: "MongoDB connection test successful",
          direct: {
            success: true,
            serverVersion: serverInfo.version,
            uptime: serverInfo.uptime,
          },
          proxy: {
            // Not testing proxy connection here for simplicity
            success: null,
            message: "Proxy connection test not performed",
          },
        };
      } catch (directError) {
        logger.error(
          `Direct MongoDB connection failed: ${directError.message}`
        );

        return {
          success: false,
          error: `MongoDB connection test failed: ${directError.message}`,
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
        if (directClient) {
          await directClient.close();
        }
      }
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
   * Generate credentials for MongoDB access
   *
   * @param {string} agentId - Agent ID
   * @param {string} dbName - Database name
   * @param {string} username - Username (optional, generated if not provided)
   * @returns {Promise<Object>} - Generated credentials
   */
  async generateCredentials(agentId, dbName, username = null) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      // Generate username if not provided
      if (!username) {
        username = `user_${crypto.randomBytes(4).toString("hex")}`;
      }

      // Generate secure password
      const password = crypto.randomBytes(16).toString("hex");

      // Create connection string with the new credentials
      const domain = `${agentId}.${this.mongoDomain}`;
      const connectionString = `mongodb://${username}:${password}@${domain}:27017/${dbName}?authSource=${dbName}`;

      logger.info(`Generated MongoDB credentials for ${agentId}/${dbName}`);

      return {
        success: true,
        message: "MongoDB credentials generated successfully",
        agentId,
        dbName,
        username,
        password,
        connectionString,
        uri: `mongodb://${domain}:27017/${dbName}`,
        instructions: [
          "To create this user in MongoDB, run:",
          `use ${dbName}`,
          `db.createUser({user: "${username}", pwd: "${password}", roles: ["readWrite"]})`,
        ],
      };
    } catch (error) {
      logger.error(`Error generating MongoDB credentials: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });

      return {
        success: false,
        error: `Error generating MongoDB credentials: ${error.message}`,
      };
    }
  }

  /**
   * Check if MongoDB port is available
   * @returns {Promise<boolean>} True if MongoDB port configuration is ok
   */
  async checkMongoDBPort() {
    try {
      if (!this.haproxyManager) {
        logger.warn("HAProxy manager not available, cannot check MongoDB port");
        return false;
      }

      // Delegate to HAProxy manager
      const result = await this.haproxyManager.checkMongoDBPort();
      return result.success;
    } catch (error) {
      logger.error(`Error checking MongoDB port: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });
      return false;
    }
  }

  /**
   * Ensure MongoDB port is configured in HAProxy
   * @returns {Promise<boolean>} True if configuration was successful
   */
  async ensureMongoDBPort() {
    try {
      if (!this.haproxyManager) {
        logger.warn(
          "HAProxy manager not available, cannot ensure MongoDB port"
        );
        return false;
      }

      // Delegate to HAProxy manager
      const result = await this.haproxyManager.ensureMongoDBPort();
      return result.success;
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
