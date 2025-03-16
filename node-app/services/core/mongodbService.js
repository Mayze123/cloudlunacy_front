/**
 * MongoDB Service
 *
 * Handles MongoDB subdomain registration and management through Traefik.
 */

const fs = require("fs").promises;
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);
const logger = require("../../utils/logger").getLogger("mongodbService");
const pathManager = require("../../utils/pathManager");

class MongoDBService {
  constructor(configManager, routingManager) {
    this.configManager = configManager;
    this.routingManager = routingManager;
    this.initialized = false;
    this.mongoDomain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
    this.mongoPort = 27017;
    this.traefikContainer = process.env.TRAEFIK_CONTAINER || "traefik";
    this.traefikConfigPath = null;
  }

  /**
   * Initialize the MongoDB service
   */
  async initialize() {
    logger.info("Initializing MongoDB service");

    try {
      // Initialize path manager if needed
      if (!pathManager.initialized) {
        await pathManager.initialize();
      }

      // Set paths from path manager
      this.traefikConfigPath = pathManager.getPath('traefikConfig');

      // Ensure MongoDB port is properly configured
      await this.ensureMongoDBPort();

      // Ensure MongoDB entrypoint is properly configured
      await this.ensureMongoDBEntrypoint();

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
      // Create TCP route for this agent
      const routeResult = await this.routingManager.addTcpRoute(
        agentId,
        `${agentId}.${this.mongoDomain}`,
        `${targetIp}:${this.mongoPort}`,
        { useTls }
      );

      if (!routeResult.success) {
        throw new Error(`Failed to add TCP route: ${routeResult.error}`);
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

      // Build MongoDB URL
      const mongodbUrl = `mongodb://${agentId}.${this.mongoDomain}:${this.mongoPort}`;

      // Build connection string
      const connectionString = useTls
        ? `mongodb://username:password@${agentId}.${this.mongoDomain}:${this.mongoPort}/admin?ssl=true&tlsAllowInvalidCertificates=true`
        : `mongodb://username:password@${agentId}.${this.mongoDomain}:${this.mongoPort}/admin`;

      return {
        success: true,
        agentId,
        targetIp,
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
      // Remove TCP route for this agent
      const routeResult = await this.routingManager.removeTcpRoute(agentId);

      if (!routeResult.success) {
        throw new Error(`Failed to remove TCP route: ${routeResult.error}`);
      }

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

      // Test connection through Traefik
      const traefikResult = await this._testTraefikConnection(agentId);

      return {
        success: traefikResult.success,
        message: traefikResult.success
          ? `Successfully connected to MongoDB for agent ${agentId}`
          : `Failed to connect to MongoDB for agent ${agentId}`,
        directConnection: targetIp ? true : undefined,
        traefikConnection: traefikResult.success,
        error: traefikResult.error,
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
   * Check if MongoDB port is active
   *
   * @returns {Promise<boolean>} Whether the port is active
   */
  async checkMongoDBPort() {
    try {
      const { stdout } = await execAsync(
        `docker port ${this.traefikContainer} | grep ${this.mongoPort}`
      );
      return stdout.trim().length > 0;
    } catch (err) {
      logger.warn(`MongoDB port check failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Ensure MongoDB port is properly configured
   *
   * @returns {Promise<boolean>} Whether the port was fixed
   */
  async ensureMongoDBPort() {
    logger.info("Ensuring MongoDB port is properly configured");

    try {
      // Check if port is already active
      const portActive = await this.checkMongoDBPort();

      if (portActive) {
        logger.info("MongoDB port is already active");
        return false; // No changes needed
      }

      logger.warn("MongoDB port is not active, attempting to fix");

      // Check docker-compose.yml
      const composeFile = "/app/docker-compose.yml";

      try {
        const composeContent = await fs.readFile(composeFile, "utf8");

        if (!composeContent.includes(`"${this.mongoPort}:${this.mongoPort}"`)) {
          logger.warn("MongoDB port is not configured in docker-compose.yml");

          // We can't modify the docker-compose.yml file here
          // This would require a more complex solution
          logger.error("Cannot automatically fix docker-compose.yml");
          return false;
        }
      } catch (readErr) {
        logger.warn(`Failed to read docker-compose.yml: ${readErr.message}`);
      }

      // Restart Traefik to apply changes
      await this.restartTraefik();

      // Check if port is now active
      const portFixed = await this.checkMongoDBPort();

      if (portFixed) {
        logger.info("MongoDB port is now active");
        return true;
      } else {
        logger.error("Failed to fix MongoDB port");
        return false;
      }
    } catch (err) {
      logger.error(`Failed to ensure MongoDB port: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return false;
    }
  }

  /**
   * Ensure MongoDB entrypoint is properly configured
   *
   * @returns {Promise<boolean>} Whether the entrypoint was fixed
   */
  async ensureMongoDBEntrypoint() {
    logger.info("Ensuring MongoDB entrypoint is properly configured");

    try {
      // Make sure config manager is initialized
      await this.configManager.initialize();

      // Get static configuration
      const staticConfig = await this._getStaticConfig();

      // Check if MongoDB entrypoint exists
      if (
        staticConfig.entryPoints &&
        staticConfig.entryPoints.mongodb &&
        staticConfig.entryPoints.mongodb.address === `:${this.mongoPort}`
      ) {
        logger.info("MongoDB entrypoint is already configured");
        return false; // No changes needed
      }

      logger.warn("MongoDB entrypoint is not configured, attempting to fix");

      // Add MongoDB entrypoint
      if (!staticConfig.entryPoints) {
        staticConfig.entryPoints = {};
      }

      staticConfig.entryPoints.mongodb = {
        address: `:${this.mongoPort}`,
        transport: {
          respondingTimeouts: {
            idleTimeout: "1h",
          },
        },
      };

      // Save static configuration
      await this._saveStaticConfig(staticConfig);

      // Restart Traefik to apply changes
      await this.restartTraefik();

      logger.info("MongoDB entrypoint has been configured");
      return true;
    } catch (err) {
      logger.error(`Failed to ensure MongoDB entrypoint: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return false;
    }
  }

  /**
   * Restart Traefik container
   *
   * @returns {Promise<boolean>} Whether the restart was successful
   */
  async restartTraefik() {
    logger.info(`Restarting ${this.traefikContainer} container`);

    try {
      await execAsync(`docker restart ${this.traefikContainer}`);
      logger.info(`${this.traefikContainer} container restarted successfully`);

      // Wait for Traefik to start
      await new Promise((resolve) => setTimeout(resolve, 5000));

      return true;
    } catch (err) {
      logger.error(
        `Failed to restart ${this.traefikContainer}: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
        }
      );
      return false;
    }
  }

  /**
   * Test direct connection to MongoDB
   *
   * @private
   * @param {string} targetIp - The target IP address
   * @returns {Promise<Object>} Test result
   */
  async _testDirectConnection(targetIp) {
    try {
      // Try with TLS first
      const tlsCommand = `timeout 5 mongosh "mongodb://admin:adminpassword@${targetIp}:${this.mongoPort}/admin?ssl=true&tlsAllowInvalidCertificates=true" --eval "db.serverStatus()" 2>&1 || echo "Connection failed"`;
      const tlsResult = await execAsync(tlsCommand);

      if (!tlsResult.includes("Connection failed")) {
        return {
          success: true,
          useTls: true,
        };
      }

      // Try without TLS
      const noTlsCommand = `timeout 5 mongosh "mongodb://admin:adminpassword@${targetIp}:${this.mongoPort}/admin" --eval "db.serverStatus()" 2>&1 || echo "Connection failed"`;
      const noTlsResult = await execAsync(noTlsCommand);

      if (!noTlsResult.includes("Connection failed")) {
        return {
          success: true,
          useTls: false,
        };
      }

      return {
        success: false,
        error: "Failed to connect to MongoDB with or without TLS",
      };
    } catch (err) {
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Test connection through Traefik
   *
   * @private
   * @param {string} agentId - The agent ID
   * @returns {Promise<Object>} Test result
   */
  async _testTraefikConnection(agentId) {
    try {
      const hostname = `${agentId}.${this.mongoDomain}`;

      // Try with TLS first
      const tlsCommand = `timeout 10 mongosh "mongodb://admin:adminpassword@${hostname}:${this.mongoPort}/admin?ssl=true&tlsAllowInvalidCertificates=true" --eval "db.serverStatus()" 2>&1 || echo "Connection failed"`;
      const tlsResult = await execAsync(tlsCommand);

      if (!tlsResult.includes("Connection failed")) {
        return {
          success: true,
          useTls: true,
        };
      }

      // Try without TLS
      const noTlsCommand = `timeout 10 mongosh "mongodb://admin:adminpassword@${hostname}:${this.mongoPort}/admin" --eval "db.serverStatus()" 2>&1 || echo "Connection failed"`;
      const noTlsResult = await execAsync(noTlsCommand);

      if (!noTlsResult.includes("Connection failed")) {
        return {
          success: true,
          useTls: false,
        };
      }

      return {
        success: false,
        error:
          "Failed to connect to MongoDB through Traefik with or without TLS",
      };
    } catch (err) {
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Get Traefik static configuration
   *
   * @private
   * @returns {Promise<Object>} Static configuration
   */
  async _getStaticConfig() {
    try {
      const staticConfigPath = this.traefikConfigPath;
      const content = await fs.readFile(staticConfigPath, "utf8");
      return require("yaml").parse(content) || {};
    } catch (err) {
      logger.error(`Failed to get static configuration: ${err.message}`);
      return {};
    }
  }

  /**
   * Save Traefik static configuration
   *
   * @private
   * @param {Object} config - The configuration to save
   * @returns {Promise<boolean>} Whether the save was successful
   */
  async _saveStaticConfig(config) {
    try {
      const staticConfigPath = this.traefikConfigPath;
      const content = require("yaml").stringify(config);
      await fs.writeFile(staticConfigPath, content, "utf8");
      return true;
    } catch (err) {
      logger.error(`Failed to save static configuration: ${err.message}`);
      return false;
    }
  }
}

module.exports = MongoDBService;
