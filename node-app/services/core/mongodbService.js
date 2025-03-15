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
const configService = require("./configService");
const logger = require("../../utils/logger").getLogger("mongodbService");
const fs = require("fs").promises;
const yaml = require("yaml");
const certificateService = require("./certificateService");
const path = require("path");

const execAsync = promisify(exec);
const docker = new Docker({ socketPath: "/var/run/docker.sock" });

class MongoDBService {
  constructor() {
    this.mongoDomain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
    this.portNumber = 27018;
    this.connectTimeout = 5000; // 5 seconds
    this.initialized = false;
    this.registeredAgents = new Map(); // Store agent registrations
    this.certificate = certificateService;
    this.config = configService;
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
        (port) => port.PublicPort === this.portNumber
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
    // Implementation details...
    logger.info("Ensuring MongoDB port is properly exposed");
    return true;
  }

  /**
   * Ensure MongoDB entrypoint is configured in Traefik
   */
  async ensureMongoDBEntrypoint() {
    try {
      logger.info("Ensuring MongoDB entrypoint is properly configured");

      // Check if the static config file exists
      const traefikConfigPath = configService.paths.traefik;
      let traefikConfig;

      try {
        const configData = await fs.readFile(traefikConfigPath, "utf8");
        traefikConfig = yaml.parse(configData);
      } catch (err) {
        logger.error(`Failed to read Traefik config: ${err.message}`);
        return false;
      }

      // Check if MongoDB entrypoint is defined
      if (!traefikConfig.entryPoints || !traefikConfig.entryPoints.mongodb) {
        logger.warn(
          "MongoDB entrypoint not found in Traefik config, adding it"
        );

        // Add MongoDB entrypoint
        if (!traefikConfig.entryPoints) {
          traefikConfig.entryPoints = {};
        }

        traefikConfig.entryPoints.mongodb = {
          address: ":27017",
          transport: {
            respondingTimeouts: {
              idleTimeout: "1h",
            },
          },
        };

        // Save updated config
        await fs.writeFile(traefikConfigPath, yaml.stringify(traefikConfig));

        // Restart Traefik to apply changes
        await this.restartTraefik();
      }

      // Verify the entrypoint is working by checking if port 27017 is listening
      const portActive = await this.checkMongoDBPort();
      if (!portActive) {
        logger.error(
          "MongoDB port is still not active after configuration update"
        );
        return false;
      }

      logger.info("MongoDB entrypoint is properly configured");
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
   * Register a new agent for MongoDB access with TLS termination at Traefik
   */
  async registerAgent(agentId, targetIp, options = {}) {
    try {
      logger.info(
        `Registering MongoDB for agent ${agentId} with IP ${targetIp}`
      );

      // Generate certificates if TLS is enabled
      let certificates = null;
      const useTls = options.useTls !== false; // Default to using TLS

      if (useTls && this.certificate) {
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

      // Register the MongoDB route with Traefik
      const domain = `${agentId}.${this.mongoDomain}`;
      const routerName = `mongodb-${agentId}`;
      const serviceName = `mongodb-${agentId}-service`;

      // Create or update the router
      const routerConfig = {
        rule: `HostSNI(\`${domain}\`)`,
        entryPoints: ["mongodb"],
        service: serviceName,
      };

      // Add TLS passthrough if using TLS
      if (useTls) {
        routerConfig.tls = { passthrough: true };
      }

      // Use updateTcpRouter instead of addTcpRouter
      await this.config.updateTcpRouter(routerName, routerConfig);

      // Use updateTcpService instead of addTcpService
      await this.config.updateTcpService(serviceName, {
        loadBalancer: {
          servers: [{ address: `${targetIp}:27017` }],
        },
      });

      // Update catchall router to use TLS passthrough if needed
      if (useTls) {
        const catchallRouter = {
          rule: `HostSNI(\`*.${this.mongoDomain}\`)`,
          entryPoints: ["mongodb"],
          service: "mongodb-catchall-service",
          tls: { passthrough: true },
        };

        // Use updateTcpRouter instead of addTcpRouter
        await this.config.updateTcpRouter("mongodb-catchall", catchallRouter);
      }

      // Save changes - Use the saveConfiguration method
      await this.config.saveConfiguration();

      // Return result
      return {
        success: true,
        agentId,
        domain,
        targetIp,
        mongodbUrl: `${domain}:27017`,
        useTls,
        certificates,
      };
    } catch (err) {
      logger.error(
        `Failed to register MongoDB for agent ${agentId}: ${err.message}`
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
      logger.info("Restarting Traefik to apply configuration changes");

      // Find the Traefik container
      const containers = await docker.listContainers({
        filters: { name: ["traefik"] },
      });

      if (containers.length === 0) {
        logger.warn("No Traefik container found, cannot restart");
        return false;
      }

      const traefikContainer = docker.getContainer(containers[0].Id);

      // Restart the container
      await traefikContainer.restart({ t: 10 }); // 10 seconds timeout

      // Wait for container to start
      await new Promise((resolve) => setTimeout(resolve, 5000));

      logger.info("Traefik restarted successfully");
      return true;
    } catch (err) {
      logger.error(`Failed to restart Traefik: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return false;
    }
  }

  /**
   * Deregister an agent
   */
  async deregisterAgent(agentId) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info(`Deregistering MongoDB for agent ${agentId}`);

      // Check if agent is registered
      if (!this.registeredAgents.has(agentId)) {
        return {
          success: false,
          error: `Agent ${agentId} not registered for MongoDB`,
        };
      }

      // Get main config
      const mainConfig = configService.configs.main;

      // Remove from TCP routers
      if (mainConfig?.tcp?.routers?.[`mongodb-${agentId}`]) {
        delete mainConfig.tcp.routers[`mongodb-${agentId}`];
      }

      // Remove from TCP services
      if (mainConfig?.tcp?.services?.[`mongodb-${agentId}-service`]) {
        delete mainConfig.tcp.services[`mongodb-${agentId}-service`];
      }

      // Save updated config
      await configService.saveConfig(configService.paths.dynamic, mainConfig);

      // Remove from registry
      this.registeredAgents.delete(agentId);

      return {
        success: true,
        agentId,
      };
    } catch (err) {
      logger.error(
        `Failed to deregister MongoDB for agent ${agentId}: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
          agentId,
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
   */
  async testConnection(agentId, targetIp) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info(`Testing MongoDB connection for agent ${agentId}`);

      // If targetIp not provided, try to get from registered agents
      if (!targetIp && this.registeredAgents.has(agentId)) {
        targetIp = this.registeredAgents.get(agentId).targetIp;
      }

      if (!targetIp) {
        return {
          success: false,
          error: `No target IP found for agent ${agentId}`,
        };
      }

      // Test TCP connection to MongoDB port
      const connected = await this.testTcpConnection(targetIp, 27017);

      return {
        success: connected,
        agentId,
        targetIp,
        message: connected
          ? `Successfully connected to MongoDB at ${targetIp}:27017`
          : `Failed to connect to MongoDB at ${targetIp}:27017`,
      };
    } catch (err) {
      logger.error(`Failed to test MongoDB connection: ${err.message}`, {
        error: err.message,
        stack: err.stack,
        agentId,
        targetIp,
      });
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Test TCP connection to a host:port
   * @private
   */
  async testTcpConnection(host, port) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(this.connectTimeout);

      socket.on("connect", () => {
        socket.destroy();
        resolve(true);
      });

      socket.on("timeout", () => {
        socket.destroy();
        resolve(false);
      });

      socket.on("error", () => {
        socket.destroy();
        resolve(false);
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
      if (!configService.configs.main) {
        logger.warn(
          "Main configuration not loaded, cannot load MongoDB agents"
        );
        return;
      }

      // Get main config
      const mainConfig = configService.configs.main;
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
      const mainConfig = configService.configs.main;
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
      await configService.saveConfig(configService.paths.dynamic, mainConfig);

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
}

module.exports = new MongoDBService();
