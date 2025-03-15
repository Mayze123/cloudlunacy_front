/**
 * MongoDB Service
 *
 * Centralized service for MongoDB routing, connection testing, and management.
 */

const { execSync, exec } = require("child_process");
const { promisify } = require("util");
const net = require("net");
const dns = require("dns").promises;
const Docker = require("dockerode");
const configManager = require("./configManager");
const logger = require("../../utils/logger").getLogger("mongodbService");
const fs = require("fs").promises;
const yaml = require("yaml");
const certificateService = require("./certificateService");
const path = require("path");
const { MongoClient } = require("mongodb");
const routingService = require("./routingService");

const execAsync = promisify(exec);
const docker = new Docker({ socketPath: "/var/run/docker.sock" });

class MongoDBService {
  constructor(configManager, routingManager) {
    this.configManager = configManager;
    this.routingManager = routingManager;
    this.initialized = false;
    this.mongoDomain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
    this.mongoPort = 27017;
    this.traefikContainer = process.env.TRAEFIK_CONTAINER || "traefik";
    this.certsDir = process.env.CERTS_DIR || "/app/config/certs";
    this.agentCertsDir =
      process.env.AGENT_CERTS_DIR || "/app/config/certs/agents";
  }

  /**
   * Initialize the MongoDB service
   */
  async initialize() {
    logger.info("Initializing MongoDB service");

    try {
      // Ensure MongoDB port is exposed
      await this.ensureMongoDBPort();

      // Ensure MongoDB entrypoint is configured
      await this.ensureMongoDBEntrypoint();

      this.initialized = true;
      logger.info("MongoDB service initialized successfully");
    } catch (err) {
      logger.error(`Failed to initialize MongoDB service: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      throw err;
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
      // Create MongoDB route
      const routerName = `mongodb-${agentId}`;
      const serviceName = `${routerName}-service`;
      const domain = `${agentId}.${this.mongoDomain}`;

      // Add TCP route
      await this.routingManager.addTcpRoute(
        agentId,
        domain,
        `${targetIp}:${this.mongoPort}`,
        {
          entryPoint: "mongodb",
          useTls: useTls,
          tlsPassthrough: true,
        }
      );

      logger.info(`MongoDB route added for agent ${agentId}`);

      // Generate certificates if needed
      let certificates = null;
      if (useTls && this.configManager.certificateService) {
        try {
          certificates =
            await this.configManager.certificateService.generateAgentCertificate(
              agentId
            );
          logger.info(`Generated certificates for agent ${agentId}`);
        } catch (certErr) {
          logger.error(`Failed to generate certificates: ${certErr.message}`);
        }
      }

      // Construct MongoDB URL
      const mongodbUrl = `mongodb://${domain}:${this.mongoPort}`;
      const connectionString = `mongodb://username:password@${domain}:${this.mongoPort}/admin?ssl=true&tlsAllowInvalidCertificates=true`;

      return {
        success: true,
        agentId,
        domain,
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

      throw err;
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
      // Remove TCP route
      const result = await this.routingManager.removeTcpRoute(agentId);

      return {
        success: result.success,
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
        agentId,
        error: err.message,
      };
    }
  }

  /**
   * Test MongoDB connection
   *
   * @param {string} agentId - The agent ID
   * @param {string} targetIp - The target IP address
   * @returns {Promise<Object>} Test result
   */
  async testConnection(agentId, targetIp) {
    logger.info(`Testing MongoDB connection for agent ${agentId}`);

    const domain = `${agentId}.${this.mongoDomain}`;
    const directIp = targetIp || null;

    const results = {
      success: false,
      domain,
      directIp,
      tests: {},
    };

    // Test direct connection if IP is provided
    if (directIp) {
      try {
        const directCommand = `timeout 5 mongosh "mongodb://admin:adminpassword@${directIp}:${this.mongoPort}/admin?ssl=true&tlsAllowInvalidCertificates=true" --eval "db.serverStatus()" 2>&1 || echo "Connection failed"`;
        const directResult = execSync(directCommand, { encoding: "utf8" });

        results.tests.directConnection = {
          success: !directResult.includes("Connection failed"),
          message: directResult.includes("Connection failed")
            ? "Direct connection failed"
            : "Direct connection successful",
        };
      } catch (err) {
        results.tests.directConnection = {
          success: false,
          message: `Error testing direct connection: ${err.message}`,
        };
      }
    }

    // Test connection through Traefik
    try {
      const traefikCommand = `timeout 5 mongosh "mongodb://admin:adminpassword@${domain}:${this.mongoPort}/admin?ssl=true&tlsAllowInvalidCertificates=true" --eval "db.serverStatus()" 2>&1 || echo "Connection failed"`;
      const traefikResult = execSync(traefikCommand, { encoding: "utf8" });

      results.tests.traefikConnection = {
        success: !traefikResult.includes("Connection failed"),
        message: traefikResult.includes("Connection failed")
          ? "Traefik connection failed"
          : "Traefik connection successful",
      };

      // Set overall success based on Traefik connection
      results.success = results.tests.traefikConnection.success;
    } catch (err) {
      results.tests.traefikConnection = {
        success: false,
        message: `Error testing Traefik connection: ${err.message}`,
      };
    }

    return results;
  }

  /**
   * Check if MongoDB port is active
   *
   * @returns {Promise<boolean>} True if port is active
   */
  async checkMongoDBPort() {
    try {
      const result = execSync(
        `docker port ${this.traefikContainer} | grep ${this.mongoPort}`,
        { encoding: "utf8" }
      );
      return result.includes(`${this.mongoPort}`);
    } catch (err) {
      logger.warn(`MongoDB port check failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Ensure MongoDB port is exposed in Traefik
   *
   * @returns {Promise<boolean>} True if fixed
   */
  async ensureMongoDBPort() {
    logger.info("Ensuring MongoDB port is exposed in Traefik");

    // Check if port is already exposed
    const portActive = await this.checkMongoDBPort();
    if (portActive) {
      logger.info("MongoDB port is already exposed");
      return false;
    }

    logger.warn("MongoDB port is not exposed, attempting to fix");

    try {
      // Try to restart Traefik
      execSync(`docker restart ${this.traefikContainer}`, { encoding: "utf8" });
      logger.info("Restarted Traefik container");

      // Check again after restart
      const portActiveAfterRestart = await this.checkMongoDBPort();
      if (portActiveAfterRestart) {
        logger.info("MongoDB port is now exposed after restart");
        return true;
      }

      logger.warn("MongoDB port is still not exposed after restart");
      return false;
    } catch (err) {
      logger.error(`Failed to ensure MongoDB port: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return false;
    }
  }

  /**
   * Ensure MongoDB entrypoint is configured in Traefik
   *
   * @returns {Promise<boolean>} True if fixed
   */
  async ensureMongoDBEntrypoint() {
    logger.info("Ensuring MongoDB entrypoint is configured");

    try {
      // Get current configuration
      await this.configManager.initialize();
      const config = this.configManager.configs.main;

      // Check if MongoDB catchall router exists
      const hasCatchall = config?.tcp?.routers?.["mongodb-catchall"];

      if (hasCatchall) {
        logger.info("MongoDB catchall router is already configured");
        return false;
      }

      logger.warn("MongoDB catchall router is not configured, adding it");

      // Ensure TCP section exists
      if (!config.tcp) {
        config.tcp = { routers: {}, services: {} };
      }

      // Add catchall router
      config.tcp.routers["mongodb-catchall"] = {
        rule: `HostSNI(\`*.${this.mongoDomain}\`)`,
        entryPoints: ["mongodb"],
        service: "mongodb-catchall-service",
        tls: {
          passthrough: true,
        },
      };

      // Add catchall service
      config.tcp.services["mongodb-catchall-service"] = {
        loadBalancer: {
          servers: [],
        },
      };

      // Save configuration
      await this.configManager.saveConfig("main", config);
      logger.info("Added MongoDB catchall router to configuration");

      // Restart Traefik to apply changes
      await this.restartTraefik();

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
   * @returns {Promise<boolean>} True if successful
   */
  async restartTraefik() {
    try {
      logger.info(`Restarting ${this.traefikContainer} container`);
      execSync(`docker restart ${this.traefikContainer}`, { encoding: "utf8" });
      logger.info(`${this.traefikContainer} container restarted`);
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
}

module.exports = MongoDBService;
