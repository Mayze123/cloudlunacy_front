/**
 * MongoDB Service
 *
 * Handles MongoDB subdomain registration and management through Traefik.
 */

const fs = require("fs").promises;
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
    if (this.initialized) return;

    logger.info("Initializing MongoDB service");

    try {
      // Initialize path manager if needed
      if (!pathManager.initialized) {
        await pathManager.initialize();
      }

      // Set paths from path manager
      this.traefikConfigPath = pathManager.getPath("traefikConfig");

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
      // Use the target IP directly instead of a fixed container name
      // If targetIp is localhost or 127.0.0.1, use the container name with the agent ID
      let targetAddress;
      if (targetIp === "127.0.0.1" || targetIp === "localhost") {
        // For local/internal agents, use a container name pattern that can be resolved in the Docker network
        const containerName = `mongodb-${agentId}`;
        targetAddress = `${containerName}:${this.mongoPort}`;
        logger.info(
          `Using container name ${containerName} for local agent ${agentId}`
        );
      } else {
        // For external agents, use the IP directly
        targetAddress = `${targetIp}:${this.mongoPort}`;
        logger.info(`Using direct IP ${targetIp} for agent ${agentId}`);
      }

      // Create TCP route for this agent
      const routeResult = await this.routingManager.addTcpRoute(
        agentId,
        `${agentId}.${this.mongoDomain}`,
        targetAddress,
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
        targetAddress,
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
   * Ensure MongoDB port is correctly exposed in Docker
   */
  async ensureMongoDBPort() {
    const maxRetries = 3;
    let retries = 0;
    let success = false;

    while (!success && retries < maxRetries) {
      try {
        logger.info("Ensuring MongoDB port is correctly exposed");

        // Check if MongoDB port is already correctly exposed
        const portCheck = await this.checkMongoDBPort();
        if (portCheck) {
          logger.info("MongoDB port already correctly exposed");
          return true;
        }

        // Run the Docker command to update the port mapping
        logger.info("Updating MongoDB port configuration");

        const dockerCommand = `docker exec "${this.traefikContainer}" /fix-mongo-port.sh`;

        logger.debug(`Running command: ${dockerCommand}`);

        const { stdout, stderr } = await execAsync(dockerCommand, {
          timeout: 30000, // 30 seconds timeout
        });

        if (stderr && !stderr.includes("Forwarding")) {
          logger.warn(`Command stderr: ${stderr}`);
        }

        logger.debug(`Command stdout: ${stdout}`);

        // Verify the port was exposed correctly
        const verifyCheck = await this.checkMongoDBPort();
        if (!verifyCheck) {
          throw new Error("Port update verification failed");
        }

        logger.info("MongoDB port successfully updated");
        success = true;
        return true;
      } catch (err) {
        retries++;
        const waitTime = 2000 * retries; // Exponential backoff

        logger.error(
          `Failed to ensure MongoDB port (attempt ${retries}/${maxRetries}): ${err.message}`,
          {
            error: err.message,
            stack: err.stack,
          }
        );

        if (retries < maxRetries) {
          logger.info(`Retrying in ${waitTime / 1000} seconds...`);
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        } else {
          logger.error("Maximum retry attempts reached, giving up");
          throw new Error(
            `Failed to ensure MongoDB port after ${maxRetries} attempts: ${err.message}`
          );
        }
      }
    }

    return success;
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
        // Entrypoint exists, but let's ensure it has the optimal configuration
        let needsUpdate = false;

        // Check for transport settings
        if (!staticConfig.entryPoints.mongodb.transport) {
          staticConfig.entryPoints.mongodb.transport = {};
          needsUpdate = true;
        }

        // Check for timeout settings
        if (!staticConfig.entryPoints.mongodb.transport.respondingTimeouts) {
          staticConfig.entryPoints.mongodb.transport.respondingTimeouts = {
            idleTimeout: "1h", // Long idle timeout for long-lived MongoDB connections
            readTimeout: "30s",
            writeTimeout: "2m",
          };
          needsUpdate = true;
        } else if (
          staticConfig.entryPoints.mongodb.transport.respondingTimeouts
            .idleTimeout !== "1h"
        ) {
          staticConfig.entryPoints.mongodb.transport.respondingTimeouts.idleTimeout =
            "1h";
          needsUpdate = true;
        }

        if (needsUpdate) {
          logger.info(
            "Updating MongoDB entrypoint configuration with optimal settings"
          );
          await this._saveStaticConfig(staticConfig);
          return true;
        }

        logger.info("MongoDB entrypoint is already optimally configured");
        return false; // No changes needed
      }

      logger.warn("MongoDB entrypoint is not configured, creating it");

      // Add MongoDB entrypoint with optimal configuration
      if (!staticConfig.entryPoints) {
        staticConfig.entryPoints = {};
      }

      staticConfig.entryPoints.mongodb = {
        address: `:${this.mongoPort}`,
        transport: {
          respondingTimeouts: {
            idleTimeout: "1h", // Long idle timeout for long-lived MongoDB connections
            readTimeout: "30s",
            writeTimeout: "2m",
          },
        },
        // Add ProxyProtocol for proper client IP handling if behind another proxy/load balancer
        proxyProtocol: {
          trustedIPs: [
            "127.0.0.1/32",
            "10.0.0.0/8",
            "172.16.0.0/12",
            "192.168.0.0/16",
          ],
        },
      };

      // Save static configuration
      await this._saveStaticConfig(staticConfig);

      // Restart Traefik to apply changes
      await this.restartTraefik();

      logger.info(
        "MongoDB entrypoint has been configured with optimal settings"
      );
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
    logger.info(
      `Testing direct MongoDB connection to ${targetIp}:${this.mongoPort}`
    );

    const timeout = 10; // 10 seconds timeout
    let tlsResult = null;
    let noTlsResult = null;

    try {
      // Try with TLS first
      const tlsCommand = `timeout ${timeout} mongosh "mongodb://admin:adminpassword@${targetIp}:${this.mongoPort}/admin?ssl=true&tlsAllowInvalidCertificates=true" --eval "db.serverStatus()" 2>&1 || echo "Connection failed"`;

      logger.debug(`Executing TLS connection test: ${tlsCommand}`);
      const { stdout: tlsOutput } = await execAsync(tlsCommand);
      tlsResult = tlsOutput;

      if (
        !tlsOutput.includes("Connection failed") &&
        !tlsOutput.includes("MongoServerError")
      ) {
        logger.info(
          `Successfully connected to MongoDB at ${targetIp}:${this.mongoPort} with TLS`
        );
        return {
          success: true,
          useTls: true,
          details: "Connected with TLS",
        };
      }

      logger.debug(`TLS connection failed: ${tlsOutput.substring(0, 200)}...`);

      // Try without TLS
      const noTlsCommand = `timeout ${timeout} mongosh "mongodb://admin:adminpassword@${targetIp}:${this.mongoPort}/admin" --eval "db.serverStatus()" 2>&1 || echo "Connection failed"`;

      logger.debug(`Executing non-TLS connection test: ${noTlsCommand}`);
      const { stdout: noTlsOutput } = await execAsync(noTlsCommand);
      noTlsResult = noTlsOutput;

      if (
        !noTlsOutput.includes("Connection failed") &&
        !noTlsOutput.includes("MongoServerError")
      ) {
        logger.info(
          `Successfully connected to MongoDB at ${targetIp}:${this.mongoPort} without TLS`
        );
        return {
          success: true,
          useTls: false,
          details: "Connected without TLS",
        };
      }

      logger.debug(
        `Non-TLS connection failed: ${noTlsOutput.substring(0, 200)}...`
      );

      // Check if we got authentication errors rather than connection errors
      if (
        tlsResult.includes("Authentication failed") ||
        noTlsResult.includes("Authentication failed")
      ) {
        logger.info(
          `MongoDB connection succeeded but authentication failed at ${targetIp}:${this.mongoPort}`
        );
        return {
          success: true,
          authError: true,
          details: "Connection succeeded but authentication failed",
        };
      }

      logger.warn(
        `Failed to connect to MongoDB at ${targetIp}:${this.mongoPort} with or without TLS`
      );
      return {
        success: false,
        error: "Failed to connect to MongoDB with or without TLS",
        tlsError: tlsResult.includes("Connection failed") ? tlsResult : null,
        noTlsError: noTlsResult.includes("Connection failed")
          ? noTlsResult
          : null,
      };
    } catch (err) {
      logger.error(
        `Error testing MongoDB connection to ${targetIp}:${this.mongoPort}: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
        }
      );

      return {
        success: false,
        error: err.message,
        command_error: true,
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
    const hostname = `${agentId}.${this.mongoDomain}`;
    logger.info(
      `Testing MongoDB connection through Traefik to ${hostname}:${this.mongoPort}`
    );

    const timeout = 15; // 15 seconds timeout (longer for Traefik routing)
    let tlsResult = null;
    let noTlsResult = null;

    try {
      // First check if the hostname resolves
      try {
        const dnsCheckCommand = `dig +short ${hostname} || host ${hostname} || echo "DNS lookup failed"`;
        const { stdout: dnsResult } = await execAsync(dnsCheckCommand);

        if (dnsResult.includes("DNS lookup failed") || !dnsResult.trim()) {
          logger.warn(`DNS lookup failed for ${hostname}`);
          return {
            success: false,
            error: `DNS lookup failed for ${hostname}. Check your DNS configuration.`,
            dns_error: true,
          };
        }

        logger.debug(`DNS lookup for ${hostname}: ${dnsResult.trim()}`);
      } catch (dnsErr) {
        logger.warn(`Error checking DNS for ${hostname}: ${dnsErr.message}`);
        // Continue anyway, as mongosh might resolve it differently
      }

      // Try with TLS first
      const tlsCommand = `timeout ${timeout} mongosh "mongodb://admin:adminpassword@${hostname}:${this.mongoPort}/admin?ssl=true&tlsAllowInvalidCertificates=true" --eval "db.serverStatus()" 2>&1 || echo "Connection failed"`;

      logger.debug(
        `Executing TLS connection test through Traefik: ${tlsCommand}`
      );
      const { stdout: tlsOutput } = await execAsync(tlsCommand);
      tlsResult = tlsOutput;

      if (
        !tlsOutput.includes("Connection failed") &&
        !tlsOutput.includes("MongoServerError")
      ) {
        logger.info(
          `Successfully connected to MongoDB at ${hostname}:${this.mongoPort} with TLS`
        );
        return {
          success: true,
          useTls: true,
          details: "Connected with TLS through Traefik",
        };
      }

      logger.debug(
        `TLS connection through Traefik failed: ${tlsOutput.substring(
          0,
          200
        )}...`
      );

      // Try without TLS
      const noTlsCommand = `timeout ${timeout} mongosh "mongodb://admin:adminpassword@${hostname}:${this.mongoPort}/admin" --eval "db.serverStatus()" 2>&1 || echo "Connection failed"`;

      logger.debug(
        `Executing non-TLS connection test through Traefik: ${noTlsCommand}`
      );
      const { stdout: noTlsOutput } = await execAsync(noTlsCommand);
      noTlsResult = noTlsOutput;

      if (
        !noTlsOutput.includes("Connection failed") &&
        !noTlsOutput.includes("MongoServerError")
      ) {
        logger.info(
          `Successfully connected to MongoDB at ${hostname}:${this.mongoPort} without TLS`
        );
        return {
          success: true,
          useTls: false,
          details: "Connected without TLS through Traefik",
        };
      }

      logger.debug(
        `Non-TLS connection through Traefik failed: ${noTlsOutput.substring(
          0,
          200
        )}...`
      );

      // Check if we got authentication errors rather than connection errors
      if (
        tlsResult.includes("Authentication failed") ||
        noTlsResult.includes("Authentication failed")
      ) {
        logger.info(
          `MongoDB connection through Traefik succeeded but authentication failed at ${hostname}:${this.mongoPort}`
        );
        return {
          success: true,
          authError: true,
          details: "Connection succeeded but authentication failed",
        };
      }

      // Check for specific errors in the output
      if (
        tlsResult.includes("network timeout") ||
        noTlsResult.includes("network timeout")
      ) {
        logger.warn(
          `Network timeout connecting to MongoDB at ${hostname}:${this.mongoPort}`
        );
        return {
          success: false,
          error:
            "Network timeout, Traefik might not be forwarding traffic correctly",
          timeout: true,
        };
      }

      logger.warn(
        `Failed to connect to MongoDB at ${hostname}:${this.mongoPort} through Traefik with or without TLS`
      );
      return {
        success: false,
        error:
          "Failed to connect to MongoDB through Traefik with or without TLS",
        tlsError: tlsResult.includes("Connection failed") ? tlsResult : null,
        noTlsError: noTlsResult.includes("Connection failed")
          ? noTlsResult
          : null,
      };
    } catch (err) {
      logger.error(
        `Error testing MongoDB connection through Traefik to ${hostname}:${this.mongoPort}: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
        }
      );

      return {
        success: false,
        error: err.message,
        command_error: true,
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

  async ensureMongoDBRouting(agentId, targetHost, targetPort) {
    logger.info(
      `Ensuring MongoDB routing for agent ${agentId} to ${targetHost}:${targetPort}`
    );

    try {
      // Get the main configuration
      const config = await this.configManager.getConfig("main");

      // Ensure TCP section exists
      if (!config.tcp) {
        config.tcp = { routers: {}, services: {} };
      }

      // Create specific router for this agent
      const routerName = `mongodb-${agentId}`;
      config.tcp.routers[routerName] = {
        rule: `HostSNI(\`${agentId}.${this.mongoDomain}\`)`,
        entryPoints: ["mongodb"],
        service: `${routerName}-service`,
        tls: {
          // Use TLS termination instead of passthrough
          certResolver: "default",
          domains: [
            {
              main: this.mongoDomain,
              sans: [`*.${this.mongoDomain}`],
            },
          ],
        },
      };

      // Create service with the target server
      config.tcp.services[`${routerName}-service`] = {
        loadBalancer: {
          servers: [{ address: `${targetHost}:${targetPort}` }],
          terminationDelay: 100,
          // Add serversTransport for re-encryption
          serversTransport: "mongodb-tls-transport",
        },
      };

      // Save the updated configuration
      await this.configManager.saveConfig("main", config);

      // Reload Traefik to apply changes (if needed)
      await this.reloadTraefik();

      return true;
    } catch (err) {
      logger.error(`Failed to ensure MongoDB routing: ${err.message}`);
      return false;
    }
  }

  async registerMongoDBRoute(agentId, targetHost, targetPort = 27017) {
    logger.info(
      `Registering MongoDB route for agent ${agentId} to ${targetHost}:${targetPort}`
    );

    try {
      // Get the main configuration
      const config = await this.configManager.getConfig("main");

      // Ensure TCP section exists
      if (!config.tcp) {
        config.tcp = { routers: {}, services: {} };
      }

      // Create specific router for this agent
      const routerName = `mongodb-${agentId}`;
      config.tcp.routers[routerName] = {
        rule: `HostSNI(\`${agentId}.${this.mongoDomain}\`)`,
        entryPoints: ["mongodb"],
        service: `${routerName}-service`,
        tls: {
          // Use TLS termination instead of passthrough
          certResolver: "default",
          domains: [
            {
              main: this.mongoDomain,
              sans: [`*.${this.mongoDomain}`],
            },
          ],
        },
      };

      // Create service with the target server
      config.tcp.services[`${routerName}-service`] = {
        loadBalancer: {
          servers: [{ address: `${targetHost}:${targetPort}` }],
          terminationDelay: 100,
          // Add serversTransport for re-encryption
          serversTransport: "mongodb-tls-transport",
        },
      };

      // Save the updated configuration
      await this.configManager.saveConfig("main", config);

      // Reload Traefik to apply changes
      await this.reloadTraefik();

      return {
        success: true,
        agentId,
        domain: `${agentId}.${this.mongoDomain}`,
        targetHost,
        targetPort,
      };
    } catch (err) {
      logger.error(`Failed to register MongoDB route: ${err.message}`);
      throw err;
    }
  }
}

module.exports = MongoDBService;
