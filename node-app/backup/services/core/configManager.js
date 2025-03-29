/**
 * Configuration Manager
 *
 * Handles loading, validating, and updating HAProxy configuration files
 */
const fs = require("fs").promises;
const yaml = require("yaml");
const path = require("path");
const logger = require("../../utils/logger").getLogger("configManager");
const pathManager = require("../../utils/pathManager");

class ConfigManager {
  constructor() {
    this.initialized = false;
    this.configs = {
      main: null,
      haproxy: null,
    };

    // Use pathManager for paths
    this.paths = {
      main: null,
      static: null,
      haproxy: null,
    };

    logger.info("ConfigManager initialized");
  }

  /**
   * Initialize the configuration manager
   */
  async initialize() {
    try {
      logger.info("Initializing configuration manager");

      // Initialize path manager if needed
      if (!pathManager.initialized) {
        await pathManager.initialize();
      }

      // Set paths from path manager
      this.paths.main = pathManager.getPath("dynamicConfig");
      this.paths.static = pathManager.getPath("haproxyConfig");
      this.paths.haproxy = pathManager.getPath("haproxyConfig");

      // Load the main configuration
      await this.loadConfig("main");

      // Load HAProxy configuration
      await this.loadConfig("haproxy");

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
        logger.error(`Unknown configuration path key: ${name}`);
        throw new Error(`Unknown configuration: ${name}`);
      }

      // Check if the file exists
      let fileExists = false;
      try {
        await fs.access(configPath);
        fileExists = true;
      } catch (err) {
        logger.warn(
          `Configuration file not found at ${configPath}, creating default`
        );
      }

      if (!fileExists) {
        this.configs[name] = this._createDefaultConfig(name);
        await this.saveConfig(name, this.configs[name]);
        logger.info(`Created default ${name} configuration at ${configPath}`);
        return this.configs[name];
      }

      // Read and parse the configuration
      const content = await fs.readFile(configPath, "utf8");
      this.configs[name] = yaml.parse(content) || {};

      // Validate and fix the configuration
      if (name === "haproxy") {
        this.validateHAProxyConfig(this.configs[name]);
      } else {
        this.validateConfig(this.configs[name]);
      }

      logger.info(`Successfully loaded ${name} configuration`);
      return this.configs[name];
    } catch (err) {
      logger.error(`Failed to load ${name} configuration: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });

      // Create a default configuration if loading failed
      this.configs[name] = this._createDefaultConfig(name);

      try {
        await this.saveConfig(name, this.configs[name]);
        logger.info(`Created default ${name} configuration as fallback`);
      } catch (saveErr) {
        logger.error(
          `Failed to save default ${name} configuration: ${saveErr.message}`
        );
      }

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
          routers: {},
          middlewares: {
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
          routers: {},
          services: {},
        },
      };
    } else if (name === "haproxy") {
      // Default HAProxy config structure
      return {
        frontends: {
          "https-in": {
            acls: [],
            useBackends: [],
          },
          "mongodb-in": {
            acls: [],
            useBackends: [],
          },
        },
        backends: {
          "mongodb-backend-dyn": {
            mode: "tcp",
            options: ["tcp-check"],
            servers: [],
          },
          "node-app-backend": {
            mode: "http",
            options: ["httpchk GET /health"],
            servers: [
              {
                name: "node-app",
                address: "cloudlunacy-front:3005",
                check: true,
              },
            ],
          },
        },
      };
    }

    return {};
  }

  /**
   * Validate the configuration
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

    return true;
  }

  /**
   * Validate the HAProxy configuration
   *
   * @param {object} config - The configuration to validate
   * @returns {boolean} - Whether the configuration is valid
   */
  validateHAProxyConfig(config) {
    // Check if the config has the required sections
    if (!config) {
      logger.error("HAProxy configuration is null or undefined");
      return false;
    }

    // Ensure frontends section exists
    if (!config.frontends) {
      logger.warn(
        "Frontends section missing from HAProxy configuration, adding it"
      );
      config.frontends = {};
    }

    // Ensure backends section exists
    if (!config.backends) {
      logger.warn(
        "Backends section missing from HAProxy configuration, adding it"
      );
      config.backends = {};
    }

    // Ensure https-in frontend exists
    if (!config.frontends["https-in"]) {
      logger.warn(
        "https-in frontend missing from HAProxy configuration, adding it"
      );
      config.frontends["https-in"] = {
        acls: [],
        useBackends: [],
      };
    }

    // Ensure mongodb-in frontend exists
    if (!config.frontends["mongodb-in"]) {
      logger.warn(
        "mongodb-in frontend missing from HAProxy configuration, adding it"
      );
      config.frontends["mongodb-in"] = {
        acls: [],
        useBackends: [],
      };
    }

    // Ensure mongodb-backend-dyn backend exists
    if (!config.backends["mongodb-backend-dyn"]) {
      logger.warn(
        "mongodb-backend-dyn backend missing from HAProxy configuration, adding it"
      );
      config.backends["mongodb-backend-dyn"] = {
        mode: "tcp",
        options: ["tcp-check"],
        servers: [],
      };
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
      await pathManager.ensureDirectories([dir]);

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
  async getConfig(configName) {
    if (!this.initialized) {
      await this.initialize();
    }

    if (configName) {
      return this.configs[configName] || {};
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
        haproxy: 8081,
        mongo: 27017,
      },
      env: process.env.NODE_ENV || "development",
    };
  }

  /**
   * Update HAProxy static configuration
   *
   * @param {Object} config - The updated configuration
   * @returns {Promise<boolean>} Success status
   */
  async updateHAProxyConfig(config) {
    try {
      const haproxyConfigPath =
        process.env.HAPROXY_CONFIG_PATH || "/usr/local/etc/haproxy/haproxy.cfg";

      logger.info(`Updating HAProxy configuration at ${haproxyConfigPath}`);

      // Create a backup
      const backupPath = `${haproxyConfigPath}.bak`;
      try {
        const originalContent = await fs.readFile(haproxyConfigPath, "utf8");
        await fs.writeFile(backupPath, originalContent, "utf8");
        logger.info(`Created backup at ${backupPath}`);
      } catch (_err) {
        logger.warn("Failed to create backup of HAProxy configuration");
      }

      // Convert our structured config to HAProxy format
      const haproxyContent = this._convertToHAProxyFormat(config);

      // Write the configuration
      await fs.writeFile(haproxyConfigPath, haproxyContent, "utf8");
      logger.info(`HAProxy configuration updated at ${haproxyConfigPath}`);

      return true;
    } catch (err) {
      logger.error(`Failed to update HAProxy configuration: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return false;
    }
  }

  /**
   * Convert structured config to HAProxy format
   *
   * @private
   * @param {Object} config - Structured configuration
   * @returns {string} HAProxy formatted configuration
   */
  _convertToHAProxyFormat(config) {
    // This is a simplified version - the actual implementation would be more complex
    // to handle all HAProxy config options and formatting
    let result = "";

    // Global and defaults sections would typically be fixed

    // Add frontends
    if (config.frontends) {
      for (const [name, frontend] of Object.entries(config.frontends)) {
        result += `\n# Frontend ${name}\n`;
        result += `frontend ${name}\n`;

        // Add ACLs
        if (frontend.acls) {
          for (const acl of frontend.acls) {
            result += `    acl ${acl.name} ${acl.condition}\n`;
          }
        }

        // Add use_backend rules
        if (frontend.useBackends) {
          for (const ub of frontend.useBackends) {
            result += `    use_backend ${ub.backend} ${ub.condition}\n`;
          }
        }
      }
    }

    // Add backends
    if (config.backends) {
      for (const [name, backend] of Object.entries(config.backends)) {
        result += `\n# Backend ${name}\n`;
        result += `backend ${name}\n`;

        // Add mode
        if (backend.mode) {
          result += `    mode ${backend.mode}\n`;
        }

        // Add options
        if (backend.options) {
          for (const option of backend.options) {
            result += `    option ${option}\n`;
          }
        }

        // Add servers
        if (backend.servers) {
          for (const server of backend.servers) {
            let serverLine = `    server ${server.name} ${server.address}`;

            if (server.check) {
              serverLine += " check";
            }

            if (server.ssl) {
              serverLine += " ssl";
            }

            if (server.sni) {
              serverLine += ` sni str(${server.sni})`;
            }

            result += `${serverLine}\n`;
          }
        }
      }
    }

    return result;
  }

  /**
   * Get HAProxy configuration
   *
   * @returns {Promise<Object>} The HAProxy configuration
   */
  async getHAProxyConfig() {
    try {
      const haproxyConfigPath =
        process.env.HAPROXY_CONFIG_PATH || "/usr/local/etc/haproxy/haproxy.cfg";

      logger.info(`Loading HAProxy configuration from ${haproxyConfigPath}`);

      // Read the configuration
      const content = await fs.readFile(haproxyConfigPath, "utf8");

      // Parse into our structured format (simplified)
      // In reality, parsing HAProxy config would be more complex
      return this._parseHAProxyFormat(content);
    } catch (err) {
      logger.error(`Failed to load HAProxy configuration: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return {};
    }
  }

  /**
   * Parse HAProxy format to structured config
   *
   * @private
   * @param {string} content - HAProxy configuration content
   * @returns {Object} Structured configuration
   */
  _parseHAProxyFormat(content) {
    // This is a simplified implementation
    // A real implementation would need to properly parse the HAProxy config format

    // Parse frontends and backends from content
    // This is a placeholder for the actual parsing logic
    return {
      frontends: {},
      backends: {},
    };
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
            "Failed to create backup of Docker Compose configuration"
          );
        }

        // Convert to YAML and save
        const yamlContent = yaml.stringify(compose);
        await fs.writeFile(composeConfigPath, yamlContent, "utf8");
        logger.info(
          `Docker Compose configuration updated at ${composeConfigPath}`
        );
      } else {
        logger.info("No changes needed for Docker Compose configuration");
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

// Export the class instead of a singleton instance
module.exports = ConfigManager;
