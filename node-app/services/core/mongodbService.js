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
const { MongoClient } = require("mongodb");
const configManager = require("./configManager");
const routingService = require("./routingService");

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
    this.configManager = configManager;
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

      // Ensure the config manager is initialized
      if (!this.configManager.initialized) {
        await this.configManager.initialize();
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
    try {
      logger.info("Ensuring MongoDB port is properly configured in Traefik");

      // Check if port 27017 is exposed in Traefik
      const portExposed = await this.checkMongoDBPort();

      if (!portExposed) {
        logger.warn(
          "MongoDB port 27017 is not exposed in Traefik, attempting to fix"
        );

        // Update docker-compose.yml to expose port 27017
        await this.configManager.updateDockerCompose((compose) => {
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
      const staticConfig = await this.configManager.getStaticConfig();

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
        await this.configManager.updateStaticConfig(staticConfig);
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
      const config = await this.configManager.getConfig();

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
      await this.configManager.saveConfig(config);
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
      const config = await this.configManager.getConfig();

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
      await this.configManager.saveConfig(config);
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
      logger.info(`Testing MongoDB connection for agent ${agentId}`);

      const agent = this.registeredAgents.get(agentId);
      const domain = agent ? agent.domain : `${agentId}.${this.mongoDomain}`;

      // Test direct connection to target IP
      const directResult = await this.testMongoDBConnection(
        targetIp,
        27017,
        agent?.useTls || true
      );

      // Test connection through Traefik
      const traefikResult = await this.testMongoDBConnection(
        domain,
        27017,
        agent?.useTls || true
      );

      return {
        success: directResult.success || traefikResult.success,
        directConnection: directResult,
        traefikConnection: traefikResult,
      };
    } catch (err) {
      logger.error(
        `Failed to test MongoDB connection for agent ${agentId}: ${err.message}`
      );
      return {
        success: false,
        error: err.message,
      };
    }
  }

  async testMongoDBConnection(host, port, useTls) {
    try {
      logger.info(
        `Testing MongoDB connection to ${host}:${port} (TLS: ${useTls})`
      );

      // Create connection options
      const options = {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
        auth: {
          username: "admin",
          password: "adminpassword",
        },
        authSource: "admin",
      };

      // Add TLS options if enabled
      if (useTls) {
        options.tls = true;
        options.tlsAllowInvalidCertificates = true;
        options.tlsAllowInvalidHostnames = true;
      }

      // Create connection string
      const uri = `mongodb://admin:adminpassword@${host}:${port}/admin`;

      // Connect to MongoDB
      const client = new MongoClient(uri, options);
      await client.connect();

      // Test connection with ping
      const pingResult = await client.db("admin").command({ ping: 1 });

      // Close connection
      await client.close();

      return {
        success: true,
        host,
        port,
        useTls,
        pingResult,
      };
    } catch (err) {
      logger.warn(
        `MongoDB connection test failed for ${host}:${port}: ${err.message}`
      );
      return {
        success: false,
        host,
        port,
        useTls,
        error: err.message,
      };
    }
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

  /**
   * Register a MongoDB agent
   *
   * @param {string} agentId - The agent ID
   * @param {string} targetIp - The target IP address
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} - Registration result
   */
  async registerAgent(agentId, targetIp, options = {}) {
    try {
      logger.info(`Registering MongoDB agent ${agentId} with IP ${targetIp}`);

      if (!this.initialized) {
        await this.initialize();
      }

      // Add TCP route for this agent
      const subdomain = `${agentId}.${this.mongoDomain}`;
      const result = await routingService.addTcpRoute(
        agentId,
        subdomain,
        `${targetIp}:27017`,
        {
          tls: true,
          passthrough: true,
          ...options,
        }
      );

      // Generate certificates for this agent if needed
      let certificates = null;
      if (options.useTls) {
        try {
          const certResult = await certificateService.generateAgentCertificate(
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
        mongodbUrl: `${subdomain}:${this.mongoPort}`,
        targetIp,
        certificates,
      };
    } catch (err) {
      logger.error(
        `Failed to register MongoDB agent ${agentId}: ${err.message}`
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
   * @returns {Promise<Object>} - Deregistration result
   */
  async deregisterAgent(agentId) {
    try {
      logger.info(`Deregistering MongoDB agent ${agentId}`);

      if (!this.initialized) {
        await this.initialize();
      }

      // Remove TCP route for this agent
      const result = await routingService.removeTcpRoute(agentId);

      return {
        success: true,
        agentId,
        message: `MongoDB agent ${agentId} deregistered successfully`,
      };
    } catch (err) {
      logger.error(
        `Failed to deregister MongoDB agent ${agentId}: ${err.message}`
      );
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Test direct connection to MongoDB
   *
   * @param {string} targetIp - The target IP address
   * @returns {Promise<Object>} - Test result
   */
  async testDirectConnection(targetIp) {
    try {
      logger.info(`Testing direct connection to MongoDB at ${targetIp}:27017`);

      const result = await execAsync(
        `timeout 5 nc -z -v ${targetIp} 27017 2>&1 || echo "Connection failed"`
      );

      return {
        success: !result.stdout.includes("Connection failed"),
        message: result.stdout,
      };
    } catch (err) {
      logger.error(
        `Failed to test direct connection to MongoDB: ${err.message}`
      );
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Test connection through Traefik
   *
   * @param {string} agentId - The agent ID
   * @returns {Promise<Object>} - Test result
   */
  async testTraefikConnection(agentId) {
    try {
      logger.info(`Testing connection through Traefik for agent ${agentId}`);

      const subdomain = `${agentId}.${this.mongoDomain}`;
      const result = await execAsync(
        `timeout 5 nc -z -v ${subdomain} ${this.mongoPort} 2>&1 || echo "Connection failed"`
      );

      return {
        success: !result.stdout.includes("Connection failed"),
        message: result.stdout,
      };
    } catch (err) {
      logger.error(`Failed to test connection through Traefik: ${err.message}`);
      return {
        success: false,
        error: err.message,
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
