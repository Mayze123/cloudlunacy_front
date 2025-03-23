/**
 * MongoDB Service
 *
 * Handles MongoDB subdomain registration and management through HAProxy.
 */

const { exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);
const logger = require("../../utils/logger").getLogger("mongodbService");
const pathManager = require("../../utils/pathManager");
const HAProxyManager = require("./haproxyManager");

class MongoDBService {
  constructor(configManager, routingManager) {
    this.configManager = configManager;
    this.routingManager = routingManager;
    this.haproxyManager = new HAProxyManager(configManager);
    this.initialized = false;
    this.mongoDomain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
    this.mongoPort = 27017;
    this.haproxyContainer = process.env.HAPROXY_CONTAINER || "haproxy";
  }

  /**
   * Initialize the MongoDB service
   */
  async initialize() {
    if (this.initialized) return;

    logger.info("Initializing MongoDB service");

    try {
      // Initialize path manager if needed
      if (!pathManager.initialized) {
        await pathManager.initialize();
      }

      // Initialize HAProxy manager
      await this.haproxyManager.initialize();

      // Ensure MongoDB port is properly configured in HAProxy
      await this.ensureMongoDBPort();

      this.initialized = true;
      logger.info("MongoDB service initialized successfully");
      return true;
    } catch (err) {
      logger.error(`Failed to initialize MongoDB service: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return false;
    }
  }

  /**
   * Register a MongoDB agent
   *
   * @param {string} agentId - The agent ID
   * @param {string} targetIp - The target IP address
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Registration result
   */
  async registerAgent(agentId, targetIp, options = {}) {
    logger.info(
      `Registering MongoDB agent ${agentId} with target IP ${targetIp}`
    );

    if (!this.initialized) {
      await this.initialize();
    }

    const useTls = options.useTls !== false; // Default to true

    try {
      // Use the target IP directly instead of a fixed container name
      // If targetIp is localhost or 127.0.0.1, use the container name with the agent ID
      let targetHost;
      if (targetIp === "127.0.0.1" || targetIp === "localhost") {
        // For local/internal agents, use a container name pattern that can be resolved in the Docker network
        targetHost = `mongodb-${agentId}`;
        logger.info(
          `Using container name ${targetHost} for local agent ${agentId}`
        );
      } else {
        // For external agents, use the IP directly
        targetHost = targetIp;
        logger.info(`Using direct IP ${targetIp} for agent ${agentId}`);
      }

      // Update HAProxy configuration with the agent ID
      const updateResult = await this.haproxyManager.updateMongoDBBackend(
        agentId,
        targetHost,
        this.mongoPort
      );

      if (!updateResult.success) {
        throw new Error(
          `Failed to update HAProxy configuration: ${updateResult.error}`
        );
      }

      // Generate certificates if needed
      let certificates = null;
      if (useTls && this.configManager.certificate) {
        try {
          certificates =
            await this.configManager.certificate.generateAgentCertificate(
              agentId
            );
        } catch (certErr) {
          logger.warn(
            `Failed to generate certificates for agent ${agentId}: ${certErr.message}`
          );
        }
      }

      // Build MongoDB URL with agentId subdomain
      const mongodbUrl = `mongodb://${agentId}.${this.mongoDomain}:${this.mongoPort}`;

      // Build connection string
      const connectionString = useTls
        ? `mongodb://username:password@${agentId}.${this.mongoDomain}:${this.mongoPort}/admin?ssl=true&tlsAllowInvalidCertificates=true`
        : `mongodb://username:password@${agentId}.${this.mongoDomain}:${this.mongoPort}/admin`;

      return {
        success: true,
        agentId,
        targetIp,
        targetHost,
        mongodbUrl,
        connectionString,
        certificates,
        useTls,
      };
    } catch (err) {
      logger.error(
        `Failed to register MongoDB agent ${agentId}: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
        }
      );

      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Deregister a MongoDB agent
   *
   * @param {string} agentId - The agent ID
   * @returns {Promise<Object>} Deregistration result
   */
  async deregisterAgent(agentId) {
    logger.info(`Deregistering MongoDB agent ${agentId}`);

    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // With HAProxy, we don't need to remove the configuration
      // since we're using a dynamic agent ID approach with a single backend
      // We simply return success

      return {
        success: true,
        agentId,
        message: `MongoDB agent ${agentId} deregistered successfully`,
      };
    } catch (err) {
      logger.error(
        `Failed to deregister MongoDB agent ${agentId}: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
        }
      );

      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Test MongoDB connection
   *
   * @param {string} agentId - The agent ID
   * @param {string} targetIp - The target IP address (optional)
   * @returns {Promise<Object>} Test result
   */
  async testConnection(agentId, targetIp) {
    logger.info(`Testing MongoDB connection for agent ${agentId}`);

    try {
      // Test direct connection if target IP is provided
      if (targetIp) {
        const directResult = await this._testDirectConnection(targetIp);

        if (!directResult.success) {
          return {
            success: false,
            message: `Failed to connect directly to MongoDB at ${targetIp}:${this.mongoPort}`,
            error: directResult.error,
          };
        }
      }

      // Test connection through HAProxy with agentId subdomain
      const haproxyResult = await this._testHAProxyConnection(agentId);

      return {
        success: haproxyResult.success,
        message: haproxyResult.success
          ? `Successfully connected to MongoDB for agent ${agentId}`
          : `Failed to connect to MongoDB for agent ${agentId}`,
        directConnection: targetIp ? true : undefined,
        haproxyConnection: haproxyResult.success,
        error: haproxyResult.error,
      };
    } catch (err) {
      logger.error(
        `Error testing MongoDB connection for agent ${agentId}: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
        }
      );

      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Check if MongoDB port is properly configured in HAProxy
   */
  async checkMongoDBPort() {
    try {
      const { stdout } = await execAsync(
        `docker port ${this.haproxyContainer} | grep ${this.mongoPort}`
      );
      return stdout.includes(this.mongoPort.toString());
    } catch (err) {
      logger.error(`Error checking MongoDB port: ${err.message}`);
      return false;
    }
  }

  /**
   * Ensure MongoDB port is properly configured in HAProxy
   */
  async ensureMongoDBPort() {
    const portConfigured = await this.checkMongoDBPort();

    if (!portConfigured) {
      logger.warn(
        `MongoDB port ${this.mongoPort} is not properly configured in HAProxy`
      );
      // We rely on docker-compose to configure the ports correctly
      // If the port is not configured, we log a warning but don't try to fix it automatically
    } else {
      logger.info(
        `MongoDB port ${this.mongoPort} is properly configured in HAProxy`
      );
    }

    return portConfigured;
  }

  /**
   * Test direct connection to MongoDB
   * @param {string} targetIp - Target IP address
   * @returns {Promise<Object>} Test result
   */
  async _testDirectConnection(targetIp) {
    try {
      // Using nc (netcat) to test TCP connection
      const { stdout, stderr } = await execAsync(
        `timeout 5 nc -zv ${targetIp} ${this.mongoPort} 2>&1`
      );

      const isConnected =
        stdout.includes("succeeded") || stderr.includes("succeeded");

      if (isConnected) {
        logger.info(
          `Direct connection to ${targetIp}:${this.mongoPort} successful`
        );
        return { success: true };
      } else {
        logger.warn(
          `Direct connection to ${targetIp}:${this.mongoPort} failed`
        );
        return {
          success: false,
          error: `Could not connect to ${targetIp}:${this.mongoPort}`,
        };
      }
    } catch (err) {
      logger.error(`Direct connection test failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Test connection through HAProxy
   * @param {string} agentId - Agent ID for the subdomain
   * @returns {Promise<Object>} Test result
   */
  async _testHAProxyConnection(agentId) {
    try {
      // Create a command to test the connection via HAProxy
      // We use openssl s_client to test the TLS connection with SNI
      const domain = `${agentId}.${this.mongoDomain}`;
      const { stdout, stderr } = await execAsync(
        `timeout 5 openssl s_client -connect localhost:${this.mongoPort} -servername ${domain} -verify_return_error 2>&1`
      );

      // Check if the TLS handshake completed successfully
      const isConnected =
        stdout.includes("Verification") || stderr.includes("Verification");

      if (isConnected) {
        logger.info(`Connection through HAProxy to ${domain} successful`);
        return { success: true };
      } else {
        logger.warn(`Connection through HAProxy to ${domain} failed`);
        return {
          success: false,
          error: `Could not connect to ${domain} through HAProxy`,
        };
      }
    } catch (err) {
      logger.error(`HAProxy connection test failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }
}

module.exports = MongoDBService;
