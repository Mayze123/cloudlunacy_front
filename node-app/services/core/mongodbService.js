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
  constructor() {
    this.mongoDomain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
    this.mongoPort = 27017;
    this.connectTimeout = 5000; // 5 seconds
    this.initialized = false;
    this.registeredAgents = new Map(); // Store agent registrations
    this.certificate = certificateService;
    this.config = configManager;
    this.traefikContainer = process.env.TRAEFIK_CONTAINER || "traefik";
    this.certsDir = process.env.CERTS_DIR || "/app/config/certs";
    this.agentCertsDir =
      process.env.AGENT_CERTS_DIR || "/app/config/certs/agents";
  }

  /**
   * Initialize the MongoDB service
   */
  async initialize() {
    if (this.initialized) {
      return true;
    }

    try {
      logger.info("Initializing MongoDB service");

      // Use configService instead of configManager
      if (!configManager.initialized) {
        await configManager.initialize();
      }

      // Ensure MongoDB port is exposed in Traefik
      const portExposed = await this.checkMongoDBPort();
      if (!portExposed) {
        logger.warn("MongoDB port not exposed in Traefik, attempting to fix");
        const entrypointFixed = await this.ensureMongoDBEntrypoint();

        if (!entrypointFixed) {
          logger.error("Failed to configure MongoDB entrypoint in Traefik");
          // Continue initialization but log the error
        } else {
          logger.info("Successfully configured MongoDB entrypoint");
        }
      }

      // Load registered agents from configuration
      await this.loadRegisteredAgents();

      this.initialized = true;
      logger.info("MongoDB service initialized successfully");
      return true;
    } catch (err) {
      logger.error(`Failed to initialize MongoDB service: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      throw err;
    }
  }

  /**
   * Check if MongoDB port is exposed in Traefik
   */
  async checkMongoDBPort() {
    try {
      logger.debug("Checking if MongoDB port is exposed in Traefik");

      // Check if Traefik container exists
      const containers = await docker.listContainers({
        filters: { name: ["traefik"] },
      });

      if (containers.length === 0) {
        logger.warn("No Traefik container found");
        return false;
      }

      const traefikContainer = containers[0];
      const ports = traefikContainer.Ports || [];

      // Check if port 27017 is exposed
      const mongoPortExposed = ports.some(
        (port) => port.PublicPort === this.mongoPort
      );

      if (mongoPortExposed) {
        logger.debug("MongoDB port is exposed in Traefik");
        return true;
      } else {
        logger.warn("MongoDB port is not exposed in Traefik");
        return false;
      }
    } catch (err) {
      logger.error(`Error checking MongoDB port: ${err.message}`);
      return false;
    }
  }

  /**
   * Ensure MongoDB port is exposed in Traefik
   */
  async ensureMongoDBPort() {
    try {
      logger.info("Ensuring MongoDB port is properly configured in Traefik");

      // Check if port 27017 is exposed in Traefik
      const portExposed = await this.checkMongoDBPort();

      if (!portExposed) {
        logger.warn(
          "MongoDB port 27017 is not exposed in Traefik, attempting to fix"
        );

        // Update docker-compose.yml to expose port 27017
        await configManager.updateDockerCompose((compose) => {
          if (
            compose.services &&
            compose.services.traefik &&
            compose.services.traefik.ports
          ) {
            // Check if port 27017 is already mapped
            const hasPort = compose.services.traefik.ports.some(
              (port) => port === "27017:27017" || port === 27017
            );

            if (!hasPort) {
              compose.services.traefik.ports.push("27017:27017");
              return true; // Indicate that compose was modified
            }
          }
          return false; // No changes needed
        });

        return true;
      }

      return false; // No changes needed
    } catch (err) {
      logger.error(`Failed to ensure MongoDB port: ${err.message}`);
      return false;
    }
  }

  /**
   * Ensure MongoDB entrypoint is configured in Traefik
   */
  async ensureMongoDBEntrypoint() {
    try {
      logger.info(
        "Ensuring MongoDB entrypoint is properly configured in Traefik"
      );

      // Check if MongoDB entrypoint is configured in Traefik static config
      const staticConfig = await configManager.getStaticConfig();

      let needsUpdate = false;

      if (!staticConfig.entryPoints || !staticConfig.entryPoints.mongodb) {
        logger.warn(
          "MongoDB entrypoint is not configured in Traefik, adding it"
        );

        if (!staticConfig.entryPoints) {
          staticConfig.entryPoints = {};
        }

        staticConfig.entryPoints.mongodb = {
          address: ":27017",
          transport: {
            respondingTimeouts: {
              idleTimeout: "1h",
            },
          },
        };

        needsUpdate = true;
      }

      if (needsUpdate) {
        await configManager.updateStaticConfig(staticConfig);
        return true;
      }

      return false; // No changes needed
    } catch (err) {
      logger.error(`Failed to ensure MongoDB entrypoint: ${err.message}`);
      return false;
    }
  }

  /**
   * Register a new agent for MongoDB access with TLS termination at Traefik
   */
  async registerMongoDBAgent(agentId, targetIp, useTls = true) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info(
        `Registering MongoDB agent ${agentId} with IP ${targetIp}, TLS: ${useTls}`
      );

      // Create router and service names
      const routerName = `mongodb-${agentId}`;
      const serviceName = `mongodb-${agentId}-service`;

      // Get the current Traefik configuration
      const config = await configManager.getConfig();

      // Ensure tcp section exists
      if (!config.tcp) {
        config.tcp = { routers: {}, services: {} };
      }

      if (!config.tcp.routers) {
        config.tcp.routers = {};
      }

      if (!config.tcp.services) {
        config.tcp.services = {};
      }

      // Add the catchall router if it doesn't exist
      if (!config.tcp.routers["mongodb-catchall"]) {
        logger.info("Adding MongoDB catchall router");
        config.tcp.routers["mongodb-catchall"] = {
          rule: `HostSNI(\`*.${this.mongoDomain}\`)`,
          entryPoints: ["mongodb"],
          service: "mongodb-catchall-service",
          tls: {
            passthrough: true,
          },
        };

        if (!config.tcp.services["mongodb-catchall-service"]) {
          config.tcp.services["mongodb-catchall-service"] = {
            loadBalancer: {
              servers: [],
            },
          };
        }
      }

      // Add the router for this specific agent
      logger.info(`Adding router for ${agentId}.${this.mongoDomain}`);
      config.tcp.routers[routerName] = {
        rule: `HostSNI(\`${agentId}.${this.mongoDomain}\`)`,
        entryPoints: ["mongodb"],
        service: serviceName,
        tls: {
          passthrough: useTls,
        },
      };

      // Add the service with the target IP
      logger.info(`Adding service for ${targetIp}:27017`);
      config.tcp.services[serviceName] = {
        loadBalancer: {
          servers: [
            {
              address: `${targetIp}:27017`,
            },
          ],
        },
      };

      // Save the updated configuration
      await configManager.saveConfig(config);
      logger.info(`Updated Traefik configuration for agent ${agentId}`);

      // Restart Traefik to apply changes
      try {
        logger.info("Restarting Traefik to apply configuration changes");
        execSync(`docker restart ${this.traefikContainer}`);
        logger.info("Traefik restarted successfully");
      } catch (err) {
        logger.error(`Failed to restart Traefik: ${err.message}`, {
          error: err.message,
          stack: err.stack,
        });
        // Continue anyway, as the config is updated
      }

      // Return the registration result
      return {
        success: true,
        agentId,
        targetIp,
        tlsEnabled: useTls,
        connectionString: `mongodb://username:password@${agentId}.${
          this.mongoDomain
        }:27017/admin?${
          useTls ? "ssl=true&tlsAllowInvalidCertificates=true" : ""
        }`,
      };
    } catch (err) {
      logger.error(
        `Failed to register MongoDB agent ${agentId}: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
          agentId,
          targetIp,
        }
      );
      throw err;
    }
  }

  /**
   * Validate inputs
   * @private
   */
  validateInputs(agentId, targetIp) {
    // Validate agent ID (alphanumeric and hyphens)
    const validAgentId = /^[a-z0-9-]+$/.test(agentId);

    // Validate IP address
    const validIp =
      /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(
        targetIp
      );

    if (!validAgentId) {
      logger.warn(`Invalid agent ID format: ${agentId}`);
    }

    if (!validIp) {
      logger.warn(`Invalid IP address format: ${targetIp}`);
    }

    return validAgentId && validIp;
  }

  /**
   * Repair MongoDB configuration
   */
  async repair() {
    try {
      logger.info("Repairing MongoDB service");

      // Re-initialize
      this.initialized = false;
      await this.initialize();

      // Check and fix MongoDB configuration
      await this.ensureMongoDBEntrypoint();

      logger.info("MongoDB service repaired successfully");
      return true;
    } catch (err) {
      logger.error(`Failed to repair MongoDB service: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      throw err;
    }
  }

  /**
   * Restart Traefik to apply configuration changes
   */
  async restartTraefik() {
    try {
      logger.info("Restarting Traefik to apply changes");

      execSync("docker restart traefik");

      logger.info("Traefik restarted successfully");
      return true;
    } catch (err) {
      logger.error(`Failed to restart Traefik: ${err.message}`);
      return false;
    }
  }

  /**
   * Deregister an agent
   */
  async unregisterMongoDBAgent(agentId) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info(`Unregistering MongoDB agent ${agentId}`);

      // Create router and service names
      const routerName = `mongodb-${agentId}`;
      const serviceName = `mongodb-${agentId}-service`;

      // Get the current Traefik configuration
      const config = await configManager.getConfig();

      // Remove the router and service if they exist
      if (config.tcp && config.tcp.routers && config.tcp.routers[routerName]) {
        delete config.tcp.routers[routerName];
        logger.info(`Removed router ${routerName}`);
      }

      if (
        config.tcp &&
        config.tcp.services &&
        config.tcp.services[serviceName]
      ) {
        delete config.tcp.services[serviceName];
        logger.info(`Removed service ${serviceName}`);
      }

      // Save the updated configuration
      await configManager.saveConfig(config);
      logger.info(
        `Updated Traefik configuration after removing agent ${agentId}`
      );

      // Restart Traefik to apply changes
      try {
        logger.info("Restarting Traefik to apply configuration changes");
        execSync(`docker restart ${this.traefikContainer}`);
        logger.info("Traefik restarted successfully");
      } catch (err) {
        logger.error(`Failed to restart Traefik: ${err.message}`, {
          error: err.message,
          stack: err.stack,
        });
        // Continue anyway, as the config is updated
      }

      return {
        success: true,
        agentId,
        message: `MongoDB agent ${agentId} unregistered successfully`,
      };
    } catch (err) {
      logger.error(
        `Failed to unregister MongoDB agent ${agentId}: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
          agentId,
        }
      );
      throw err;
    }
  }

  /**
   * Test MongoDB connection
   */
  async testConnection(agentId, targetIp) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info(`Testing MongoDB connection for agent ${agentId}`);

      // Get target IP from registry if not provided
      if (!targetIp) {
        const agent = this.registeredAgents.get(agentId);
        if (!agent) {
          return {
            success: false,
            message: `Agent ${agentId} not found`,
          };
        }
        targetIp = agent.targetIp;
      }

      // Test direct connection to MongoDB
      const directResult = await this.testDirectConnection(targetIp);

      // Test connection through Traefik
      const subdomain = `${agentId}.${this.mongoDomain}`;
      const traefikResult = await this.testTraefikConnection(subdomain);

      return {
        success: directResult.success || traefikResult.success,
        directConnection: directResult,
        traefikConnection: traefikResult,
      };
    } catch (err) {
      logger.error(
        `Failed to test MongoDB connection for agent ${agentId}: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
        }
      );
      return {
        success: false,
        message: err.message,
      };
    }
  }

  /**
   * Test direct connection to MongoDB
   * @private
   * @param {string} targetIp - The target IP address
   * @returns {Promise<Object>} - Test result
   */
  async testDirectConnection(targetIp) {
    try {
      logger.debug(`Testing direct connection to MongoDB at ${targetIp}:27017`);

      // Test TCP connection
      const tcpResult = await this.testTcpConnection(targetIp, 27017);
      if (!tcpResult.success) {
        return {
          success: false,
          message: "TCP connection failed",
          details: tcpResult,
        };
      }

      // Try MongoDB connection
      const client = new MongoClient(`mongodb://${targetIp}:27017`, {
        serverSelectionTimeoutMS: 5000,
      });

      await client.connect();
      await client.db("admin").command({ ping: 1 });
      await client.close();

      return {
        success: true,
        message: "Direct connection successful",
      };
    } catch (err) {
      logger.error(`Direct MongoDB connection failed: ${err.message}`);
      return {
        success: false,
        message: `Direct connection failed: ${err.message}`,
      };
    }
  }

  /**
   * Test connection through Traefik
   * @private
   * @param {string} subdomain - The MongoDB subdomain
   * @returns {Promise<Object>} - Test result
   */
  async testTraefikConnection(subdomain) {
    try {
      logger.debug(
        `Testing MongoDB connection through Traefik to ${subdomain}`
      );

      // Test TCP connection
      const tcpResult = await this.testTcpConnection(subdomain, 27017);
      if (!tcpResult.success) {
        return {
          success: false,
          message: "TCP connection failed",
          details: tcpResult,
        };
      }

      // Try MongoDB connection with TLS
      const client = new MongoClient(
        `mongodb://${subdomain}:27017?ssl=true&tlsAllowInvalidCertificates=true`,
        {
          serverSelectionTimeoutMS: 5000,
        }
      );

      await client.connect();
      await client.db("admin").command({ ping: 1 });
      await client.close();

      return {
        success: true,
        message: "Traefik connection successful",
      };
    } catch (err) {
      logger.error(`Traefik MongoDB connection failed: ${err.message}`);
      return {
        success: false,
        message: `Traefik connection failed: ${err.message}`,
      };
    }
  }

  /**
   * Test TCP connection
   * @private
   * @param {string} host - The host to connect to
   * @param {number} port - The port to connect to
   * @returns {Promise<Object>} - Test result
   */
  async testTcpConnection(host, port) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(this.connectTimeout);

      socket.on("connect", () => {
        socket.destroy();
        resolve({
          success: true,
          message: `TCP connection to ${host}:${port} successful`,
        });
      });

      socket.on("timeout", () => {
        socket.destroy();
        resolve({
          success: false,
          message: `TCP connection to ${host}:${port} timed out`,
        });
      });

      socket.on("error", (err) => {
        socket.destroy();
        resolve({
          success: false,
          message: `TCP connection to ${host}:${port} failed: ${err.message}`,
        });
      });

      socket.connect(port, host);
    });
  }

  /**
   * Load registered agents from configuration
   */
  async loadRegisteredAgents() {
    try {
      logger.info("Loading registered MongoDB agents");

      // Clear existing registrations
      this.registeredAgents.clear();

      // Make sure config is loaded
      if (!configManager.configs || !configManager.configs.main) {
        logger.warn(
          "Main configuration not loaded, cannot load MongoDB agents"
        );
        return;
      }

      // Get main config
      const mainConfig = configManager.configs.main;
      if (!mainConfig || !mainConfig.tcp || !mainConfig.tcp.routers) {
        logger.warn("No TCP routers found in configuration");
        return;
      }

      // Find MongoDB routers
      const mongoRouters = Object.entries(mainConfig.tcp.routers).filter(
        ([name]) => name.startsWith("mongodb-") && name !== "mongodb-catchall"
      );

      for (const [name, router] of mongoRouters) {
        // Extract agent ID from router name
        const agentId = name.replace("mongodb-", "");

        // Extract target IP from service
        const serviceName = router.service;
        const service = mainConfig.tcp.services?.[serviceName];

        if (service?.loadBalancer?.servers?.length) {
          const address = service.loadBalancer.servers[0].address;
          const targetIp = address ? address.split(":")[0] : null;

          if (targetIp) {
            // Add to registry
            this.registeredAgents.set(agentId, {
              targetIp,
              registeredAt: new Date().toISOString(),
            });

            logger.debug(`Loaded MongoDB agent: ${agentId} -> ${targetIp}`);
          }
        }
      }

      logger.info(`Loaded ${this.registeredAgents.size} MongoDB agents`);
    } catch (err) {
      logger.error(`Failed to load registered agents: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      // Don't throw, just log the error
    }
  }

  /**
   * Fix MongoDB connection issues by ensuring proper TLS configuration
   */
  async fixMongoDBConnections() {
    try {
      logger.info("Fixing MongoDB connection issues");

      // Get main config
      const mainConfig = configManager.configs.main;
      if (!mainConfig) {
        logger.error("Main configuration not loaded");
        return false;
      }

      // Ensure tcp section exists
      if (!mainConfig.tcp) {
        mainConfig.tcp = { routers: {}, services: {} };
      }
      if (!mainConfig.tcp.routers) {
        mainConfig.tcp.routers = {};
      }
      if (!mainConfig.tcp.services) {
        mainConfig.tcp.services = {};
      }

      // Fix catchall router
      if (mainConfig.tcp.routers["mongodb-catchall"]) {
        logger.info("Fixing MongoDB catchall router");
        mainConfig.tcp.routers["mongodb-catchall"].tls = {
          passthrough: true,
        };
      }

      // Fix all agent routers
      let fixedCount = 0;
      for (const [routerName, router] of Object.entries(
        mainConfig.tcp.routers
      )) {
        if (
          routerName.startsWith("mongodb-") &&
          routerName !== "mongodb-catchall"
        ) {
          if (!router.tls || router.tls.passthrough !== true) {
            logger.info(`Fixing TLS configuration for router ${routerName}`);
            router.tls = { passthrough: true };
            fixedCount++;
          }
        }
      }

      // Save updated config
      await configManager.saveConfig(configManager.paths.dynamic, mainConfig);

      if (fixedCount > 0) {
        logger.info(
          `Fixed TLS configuration for ${fixedCount} MongoDB routers`
        );

        // Restart Traefik to apply changes
        await this.restartTraefik();
      }

      return true;
    } catch (err) {
      logger.error(`Failed to fix MongoDB connections: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return false;
    }
  }

  /**
   * Register a MongoDB agent
   * @param {string} agentId - The agent ID
   * @param {string} targetIp - The target IP address
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} - Registration result
   */
  async registerAgent(agentId, targetIp, options = {}) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info(`Registering MongoDB agent ${agentId} with IP ${targetIp}`);

      // Validate inputs
      if (!this.validateInputs(agentId, targetIp)) {
        throw new Error(
          `Invalid agent ID or IP address: ${agentId}, ${targetIp}`
        );
      }

      // Ensure MongoDB port is exposed
      await this.ensureMongoDBPort();

      // Ensure MongoDB entrypoint is configured
      await this.ensureMongoDBEntrypoint();

      // Create MongoDB subdomain in Traefik
      const subdomain = `${agentId}.${this.mongoDomain}`;
      const routerName = `mongodb-${agentId}`;
      const serviceName = `mongodb-${agentId}-service`;

      // Get main config
      const mainConfig = configManager.configs.main;
      if (!mainConfig) {
        throw new Error("Main configuration not loaded");
      }

      // Ensure tcp section exists
      if (!mainConfig.tcp) {
        mainConfig.tcp = { routers: {}, services: {} };
      }
      if (!mainConfig.tcp.routers) {
        mainConfig.tcp.routers = {};
      }
      if (!mainConfig.tcp.services) {
        mainConfig.tcp.services = {};
      }

      // Create router
      mainConfig.tcp.routers[routerName] = {
        rule: `HostSNI(\`${subdomain}\`)`,
        service: serviceName,
        entryPoints: ["mongodb"],
        tls: {
          passthrough: true,
        },
      };

      // Create service
      mainConfig.tcp.services[serviceName] = {
        loadBalancer: {
          servers: [
            {
              address: `${targetIp}:27017`,
            },
          ],
        },
      };

      // Save updated config
      await configManager.saveConfig(configManager.paths.dynamic, mainConfig);

      // Add to registry
      this.registeredAgents.set(agentId, {
        targetIp,
        registeredAt: new Date().toISOString(),
      });

      logger.info(`MongoDB agent ${agentId} registered successfully`);

      // Generate certificates if needed
      let certificates = null;
      if (options.useTls && this.certificate) {
        try {
          const certResult = await this.certificate.generateAgentCertificate(
            agentId
          );
          if (certResult.success) {
            certificates = {
              caCert: certResult.caCert,
              serverKey: certResult.serverKey,
              serverCert: certResult.serverCert,
            };
          }
        } catch (err) {
          logger.error(
            `Failed to generate certificates for agent ${agentId}: ${err.message}`
          );
        }
      }

      return {
        success: true,
        agentId,
        subdomain,
        targetIp,
        mongodbUrl: `mongodb://${subdomain}:27017`,
        certificates,
        connectionString: `mongodb://username:password@${subdomain}:27017/admin?ssl=true&tlsAllowInvalidCertificates=true`,
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
   * @param {string} agentId - The agent ID
   * @returns {Promise<Object>} - Deregistration result
   */
  async deregisterAgent(agentId) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info(`Deregistering MongoDB agent ${agentId}`);

      // Check if agent exists
      if (!this.registeredAgents.has(agentId)) {
        return {
          success: false,
          message: `Agent ${agentId} not found`,
        };
      }

      // Get main config
      const mainConfig = configManager.configs.main;
      if (!mainConfig || !mainConfig.tcp) {
        return {
          success: false,
          message: "Main configuration not loaded or invalid",
        };
      }

      // Remove router and service
      const routerName = `mongodb-${agentId}`;
      const serviceName = `mongodb-${agentId}-service`;

      if (mainConfig.tcp.routers && mainConfig.tcp.routers[routerName]) {
        delete mainConfig.tcp.routers[routerName];
      }

      if (mainConfig.tcp.services && mainConfig.tcp.services[serviceName]) {
        delete mainConfig.tcp.services[serviceName];
      }

      // Save updated config
      await configManager.saveConfig(configManager.paths.dynamic, mainConfig);

      // Remove from registry
      this.registeredAgents.delete(agentId);

      logger.info(`MongoDB agent ${agentId} deregistered successfully`);

      return {
        success: true,
        agentId,
        message: `Agent ${agentId} deregistered successfully`,
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
        message: err.message,
      };
    }
  }
}

// Create an alias for registerMongoDBAgent if it exists but registerAgent doesn't
if (
  MongoDBService.prototype.registerMongoDBAgent &&
  !MongoDBService.prototype.registerAgent
) {
  MongoDBService.prototype.registerAgent =
    MongoDBService.prototype.registerMongoDBAgent;
}

module.exports = new MongoDBService();
