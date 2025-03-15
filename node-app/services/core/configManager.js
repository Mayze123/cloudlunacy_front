/**
 * Configuration Manager
 *
 * Handles loading, validating, and updating Traefik configuration files
 */
const fs = require("fs").promises;
const yaml = require("yaml");
const path = require("path");
const logger = require("../../utils/logger").getLogger("configManager");

class ConfigManager {
  constructor(configPath) {
    this.configPath =
      configPath ||
      process.env.DYNAMIC_CONFIG_PATH ||
      "/app/config/dynamic.yml";
    this.configs = {
      main: null,
    };
    this.initialized = false;

    logger.info(`ConfigManager initialized with path: ${this.configPath}`);
  }

  /**
   * Initialize the configuration manager
   */
  async initialize() {
    try {
      logger.info("Initializing configuration manager");

      // Load the main configuration
      await this.loadConfig();

      this.initialized = true;
      logger.info("Configuration manager initialized successfully");

      return true;
    } catch (err) {
      logger.error(
        `Failed to initialize configuration manager: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
        }
      );

      return false;
    }
  }

  /**
   * Load the configuration from file
   */
  async loadConfig() {
    try {
      logger.info(`Loading configuration from ${this.configPath}`);

      // Check if the file exists
      try {
        await fs.access(this.configPath);
      } catch (err) {
        logger.warn(
          `Configuration file not found at ${this.configPath}, creating default`
        );
        await this.createDefaultConfig();
      }

      // Read and parse the configuration
      const content = await fs.readFile(this.configPath, "utf8");
      this.configs.main = yaml.parse(content) || {};

      // Validate and fix the configuration
      this.validateConfig(this.configs.main);

      logger.info("Configuration loaded successfully");
      return this.configs.main;
    } catch (err) {
      logger.error(`Failed to load configuration: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });

      // Create a default configuration if loading failed
      await this.createDefaultConfig();
      return this.configs.main;
    }
  }

  /**
   * Create a default configuration
   */
  async createDefaultConfig() {
    logger.info("Creating default configuration");

    // Create a basic default configuration
    this.configs.main = {
      http: {
        routers: {},
        services: {},
        middlewares: {},
      },
      tcp: {
        routers: {
          "mongodb-catchall": {
            rule: "HostSNI(`*.mongodb.cloudlunacy.uk`)",
            entryPoints: ["mongodb"],
            service: "mongodb-catchall-service",
            tls: {
              passthrough: true,
            },
          },
        },
        services: {
          "mongodb-catchall-service": {
            loadBalancer: {
              servers: [],
            },
          },
        },
      },
    };

    // Save the default configuration
    await this.saveConfig(this.configs.main);

    return this.configs.main;
  }

  /**
   * Validate the Traefik configuration
   *
   * @param {object} config - The configuration to validate
   * @returns {boolean} - Whether the configuration is valid
   */
  validateConfig(config) {
    // Check if the config has the required sections
    if (!config) {
      logger.error("Configuration is null or undefined");
      return false;
    }

    // Ensure tcp section exists
    if (!config.tcp) {
      logger.warn("TCP section missing from configuration, adding it");
      config.tcp = { routers: {}, services: {} };
    }

    if (!config.tcp.routers) {
      logger.warn("TCP routers section missing from configuration, adding it");
      config.tcp.routers = {};
    }

    if (!config.tcp.services) {
      logger.warn("TCP services section missing from configuration, adding it");
      config.tcp.services = {};
    }

    // Check MongoDB services to ensure they have servers
    for (const [serviceName, service] of Object.entries(config.tcp.services)) {
      if (
        serviceName.startsWith("mongodb-") &&
        serviceName.endsWith("-service")
      ) {
        if (!service.loadBalancer) {
          logger.warn(
            `Service ${serviceName} is missing loadBalancer, adding it`
          );
          service.loadBalancer = { servers: [] };
        }

        if (
          !service.loadBalancer.servers ||
          !Array.isArray(service.loadBalancer.servers)
        ) {
          logger.warn(
            `Service ${serviceName} is missing servers array, adding it`
          );
          service.loadBalancer.servers = [];
        }

        // Check if the service has any servers
        if (service.loadBalancer.servers.length === 0) {
          logger.warn(`Service ${serviceName} has no servers`);
          // We don't add servers here as we don't know the IP
        }
      }
    }

    return true;
  }

  /**
   * Save the Traefik configuration
   *
   * @param {object} config - The configuration to save
   * @returns {Promise<void>}
   */
  async saveConfig(config) {
    try {
      // Validate the configuration before saving
      this.validateConfig(config);

      // Convert to YAML and save
      const yamlContent = yaml.stringify(config);
      await fs.writeFile(this.configPath, yamlContent, "utf8");
      logger.info(`Configuration saved to ${this.configPath}`);
    } catch (err) {
      logger.error(`Failed to save configuration: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      throw err;
    }
  }

  /**
   * Get agent configuration
   *
   * @param {string} agentId - The agent ID
   * @returns {object} - The agent configuration
   */
  async getAgentConfig(agentId) {
    // Make sure we're initialized
    if (!this.initialized) {
      await this.initialize();
    }

    // Return the relevant parts of the configuration for this agent
    return {
      tcp: {
        routers: this.getAgentRouters(agentId),
        services: this.getAgentServices(agentId),
      },
    };
  }

  /**
   * Get agent routers
   *
   * @param {string} agentId - The agent ID
   * @returns {object} - The agent routers
   */
  getAgentRouters(agentId) {
    const routers = {};

    // Find all routers for this agent
    for (const [routerName, router] of Object.entries(
      this.configs.main?.tcp?.routers || {}
    )) {
      if (routerName.includes(agentId)) {
        routers[routerName] = router;
      }
    }

    return routers;
  }

  /**
   * Get agent services
   *
   * @param {string} agentId - The agent ID
   * @returns {object} - The agent services
   */
  getAgentServices(agentId) {
    const services = {};

    // Find all services for this agent
    for (const [serviceName, service] of Object.entries(
      this.configs.main?.tcp?.services || {}
    )) {
      if (serviceName.includes(agentId)) {
        services[serviceName] = service;
      }
    }

    return services;
  }
}

// Export a singleton instance
module.exports = new ConfigManager();
