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
  constructor() {
    this.initialized = false;
    this.configs = {
      main: null,
    };
    this.paths = {
      main: process.env.DYNAMIC_CONFIG_PATH || "/etc/traefik/dynamic.yml",
      static: process.env.STATIC_CONFIG_PATH || "/etc/traefik/traefik.yml",
    };

    logger.info(`ConfigManager initialized`);
  }

  /**
   * Initialize the configuration manager
   */
  async initialize() {
    try {
      logger.info("Initializing configuration manager");

      // Load the main configuration
      await this.loadConfig("main");

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
  async loadConfig(name) {
    try {
      logger.info(`Loading ${name} configuration`);

      const configPath = this.paths[name];
      if (!configPath) {
        throw new Error(`Unknown configuration: ${name}`);
      }

      // Check if the file exists
      try {
        await fs.access(configPath);
      } catch (err) {
        logger.warn(
          `Configuration file not found at ${configPath}, creating default`
        );
        this.configs[name] = this._createDefaultConfig(name);
        await this.saveConfig(name, this.configs[name]);
      }

      // Read and parse the configuration
      const content = await fs.readFile(configPath, "utf8");
      this.configs[name] = yaml.parse(content) || {};

      // Validate and fix the configuration
      this.validateConfig(this.configs[name]);

      logger.info(`Successfully loaded ${name} configuration`);
      return this.configs[name];
    } catch (err) {
      logger.error(`Failed to load ${name} configuration: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });

      // Create a default configuration if loading failed
      this.configs[name] = this._createDefaultConfig(name);
      await this.saveConfig(name, this.configs[name]);
      return this.configs[name];
    }
  }

  /**
   * Create a default configuration
   */
  _createDefaultConfig(name) {
    logger.info(`Creating default ${name} configuration`);

    if (name === "main") {
      return {
        http: {
          routers: {
            dashboard: {
              rule: "Host(`traefik.localhost`) && (PathPrefix(`/api`) || PathPrefix(`/dashboard`))",
              service: "api@internal",
              entryPoints: ["dashboard"],
              middlewares: ["auth"],
            },
          },
          middlewares: {
            auth: {
              basicAuth: {
                users: ["admin:$apr1$H6uskkkW$IgXLP6ewTrSuBkTrqE8wj/"],
              },
            },
            "web-to-websecure": {
              redirectScheme: {
                scheme: "https",
                permanent: true,
              },
            },
          },
          services: {},
        },
        tcp: {
          routers: {
            "mongodb-catchall": {
              rule: `HostSNI(\`*.${
                process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk"
              }\`)`,
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
    }

    return {};
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
   * Save configuration to file
   *
   * @param {string} name - Configuration name
   * @param {Object} config - Configuration to save
   * @returns {Promise<boolean>} - Success status
   */
  async saveConfig(name, config) {
    try {
      logger.info(`Saving ${name} configuration`);

      const configPath = this.paths[name];
      if (!configPath) {
        throw new Error(`Unknown configuration: ${name}`);
      }

      // Create directory if it doesn't exist
      const dir = path.dirname(configPath);
      await fs.mkdir(dir, { recursive: true });

      // Create a backup
      try {
        const backupPath = `${configPath}.bak`;
        await fs.copyFile(configPath, backupPath);
        logger.info(`Created backup at ${backupPath}`);
      } catch (err) {
        // Ignore if file doesn't exist
        if (err.code !== "ENOENT") {
          logger.warn(`Failed to create backup: ${err.message}`);
        }
      }

      // Convert to YAML and save
      const content = yaml.stringify(config);
      await fs.writeFile(configPath, content, "utf8");

      // Update in-memory configuration
      this.configs[name] = config;

      logger.info(`Successfully saved ${name} configuration`);
      return true;
    } catch (err) {
      logger.error(`Failed to save ${name} configuration: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return false;
    }
  }

  /**
   * Get agent configuration
   *
   * @param {string} agentId - The agent ID
   * @returns {object} - The agent configuration
   */
  async getAgentConfig(agentId) {
    if (!this.initialized) {
      await this.initialize();
    }

    // Get base configuration
    const config = await this.getConfig();

    // Add agent-specific configuration
    return {
      ...config,
      agentId,
      // Add any other agent-specific configuration here
    };
  }

  /**
   * Get configuration
   *
   * @returns {Object} The current configuration
   */
  async getConfig() {
    if (!this.initialized) {
      await this.initialize();
    }

    return {
      configs: this.configs,
      paths: this.paths,
      domains: {
        app: process.env.APP_DOMAIN || "apps.cloudlunacy.uk",
        mongo: process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk",
      },
      ports: {
        node: process.env.NODE_PORT || 3005,
        traefik: 8081,
        mongo: 27017,
      },
      env: process.env.NODE_ENV || "development",
    };
  }

  /**
   * Update Traefik static configuration
   *
   * @param {Object} config - The updated configuration
   * @returns {Promise<boolean>} Success status
   */
  async updateStaticConfig(config) {
    try {
      const staticConfigPath =
        process.env.STATIC_CONFIG_PATH || "/etc/traefik/traefik.yml";

      logger.info(`Updating static configuration at ${staticConfigPath}`);

      // Create a backup
      const backupPath = `${staticConfigPath}.bak`;
      try {
        const originalContent = await fs.readFile(staticConfigPath, "utf8");
        await fs.writeFile(backupPath, originalContent, "utf8");
        logger.info(`Created backup at ${backupPath}`);
      } catch (_err) {
        logger.warn(`Failed to create backup of static configuration`);
      }

      // Convert to YAML and save
      const yamlContent = yaml.stringify(config);
      await fs.writeFile(staticConfigPath, yamlContent, "utf8");
      logger.info(`Static configuration updated at ${staticConfigPath}`);

      return true;
    } catch (err) {
      logger.error(`Failed to update static configuration: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return false;
    }
  }

  /**
   * Get Traefik static configuration
   *
   * @returns {Promise<Object>} The static configuration
   */
  async getStaticConfig() {
    try {
      const staticConfigPath =
        process.env.STATIC_CONFIG_PATH || "/etc/traefik/traefik.yml";

      logger.info(`Loading static configuration from ${staticConfigPath}`);

      // Read and parse the configuration
      const content = await fs.readFile(staticConfigPath, "utf8");
      return yaml.parse(content) || {};
    } catch (err) {
      logger.error(`Failed to load static configuration: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return {};
    }
  }

  /**
   * Update Docker Compose configuration
   *
   * @param {Function} updateFn - Function to update the compose configuration
   * @returns {Promise<boolean>} Success status
   */
  async updateDockerCompose(updateFn) {
    try {
      const composeConfigPath =
        process.env.DOCKER_COMPOSE_PATH || "/app/docker-compose.yml";

      logger.info(
        `Updating Docker Compose configuration at ${composeConfigPath}`
      );

      // Read and parse the configuration
      const content = await fs.readFile(composeConfigPath, "utf8");
      const compose = yaml.parse(content) || {};

      // Apply the update function
      const updated = updateFn(compose);

      if (updated) {
        // Create a backup
        const backupPath = `${composeConfigPath}.bak`;
        try {
          await fs.writeFile(backupPath, content, "utf8");
          logger.info(`Created backup at ${backupPath}`);
        } catch (_err) {
          logger.warn(
            `Failed to create backup of Docker Compose configuration`
          );
        }

        // Convert to YAML and save
        const yamlContent = yaml.stringify(compose);
        await fs.writeFile(composeConfigPath, yamlContent, "utf8");
        logger.info(
          `Docker Compose configuration updated at ${composeConfigPath}`
        );
      } else {
        logger.info(`No changes needed for Docker Compose configuration`);
      }

      return updated;
    } catch (err) {
      logger.error(
        `Failed to update Docker Compose configuration: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
        }
      );
      return false;
    }
  }
}

// Export a singleton instance
module.exports = new ConfigManager();
