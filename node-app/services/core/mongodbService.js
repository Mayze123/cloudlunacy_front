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
const haproxyManager = require("./haproxyManager");

class MongoDBService {
  constructor() {
    this.initialized = false;
    this.mongoDomain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
    this.connectionCache = new Map();
  }

  /**
   * Initialize the MongoDB service
   */
  async initialize() {
    if (this.initialized) {
      return true;
    }

    // Initialize HAProxy manager if not already initialized
    if (!haproxyManager.initialized) {
      await haproxyManager.initialize();
    }

    this.initialized = true;
    logger.info("MongoDB service initialized");
    return true;
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
      const result = await haproxyManager.updateMongoDBBackend(
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
      const result = await haproxyManager.removeMongoDBBackend(agentId);

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
      const host = targetIp || connectionInfo.targetIp;
      const port = connectionInfo ? connectionInfo.targetPort : 27017;
      const useTls = connectionInfo ? connectionInfo.useTls : true;

      // Build connection URI
      let uri = `mongodb://admin:adminpassword@${host}:${port}/admin`;
      if (useTls) {
        uri += "?tls=true&tlsAllowInvalidCertificates=true";
      }

      logger.debug(
        `Connecting to MongoDB at ${uri.replace(/:[^:]*@/, ":***@")}`
      );

      // Connect to MongoDB
      const client = new MongoClient(uri, {
        serverSelectionTimeoutMS: 5000, // 5 seconds timeout
        connectTimeoutMS: 5000,
        socketTimeoutMS: 5000,
      });

      await client.connect();
      const adminDb = client.db("admin");
      const pingResult = await adminDb.command({ ping: 1 });
      await client.close();

      logger.info(`MongoDB connection test successful for agent ${agentId}`);

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

module.exports = new MongoDBService();
