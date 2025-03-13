// services/configManager.js
/**
 * Centralized Configuration Manager
 *
 * Handles all configuration loading, validation, and access.
 * Provides a single source of truth for configuration values.
 */

const fs = require("fs").promises;
const path = require("path");
const yaml = require("yaml");
const pathResolver = require("../utils/pathResolver");
const logger = require("../utils/logger").getLogger("configManager");

class ConfigManager {
  constructor() {
    // Configuration paths
    this.paths = {
      base: null,
      config: null,
      agents: null,
      dynamic: null,
      docker: null,
    };

    // Configuration domains
    this.domains = {
      mongo: process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk",
      app: process.env.APP_DOMAIN || "apps.cloudlunacy.uk",
    };

    // Basic templates for configuration files
    this.templates = {
      agent: null,
      dynamic: null,
    };

    // Loaded configuration cache
    this.configs = {
      agents: new Map(),
      main: null,
    };

    // Initialization state
    this.initialized = false;
  }

  /**
   * Initialize the configuration manager
   */
  async initialize() {
    if (this.initialized) {
      return true;
    }

    try {
      logger.info("Initializing configuration manager");

      // Resolve paths based on environment
      await this.resolvePaths();

      // Load templates
      this.templates = this.getConfigTemplates();

      // Ensure directories exist
      await this.ensureDirectories();

      // Validate and fix main configuration
      await this.ensureMainConfig();

      // Validate and fix agent configurations
      await this.validateAgentConfigs();

      // Test write permissions
      await this.verifyWritePermissions();

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

      // Try recovery with fallback paths
      try {
        logger.info("Attempting recovery with fallback paths");
        await this.resolvePathsFallback();

        // Ensure directories exist
        await this.ensureDirectories();

        // Validate and fix main configuration
        await this.ensureMainConfig();

        this.initialized = true;
        logger.info("Configuration manager initialized with fallback paths");
        return true;
      } catch (recoveryErr) {
        logger.error(`Recovery failed: ${recoveryErr.message}`, {
          error: recoveryErr.message,
          stack: recoveryErr.stack,
        });
        throw err;
      }
    }
  }

  /**
   * Resolve configuration paths based on environment
   */
  async resolvePaths() {
    const resolver = await pathResolver.initialize();

    this.paths.base = resolver.resolveBasePath();
    this.paths.config = resolver.resolveConfigPath();
    this.paths.agents = resolver.resolveAgentsPath();
    this.paths.dynamic = resolver.resolveDynamicConfigPath();
    this.paths.docker = resolver.resolveDockerComposePath();

    logger.info("Resolved configuration paths", { paths: this.paths });
    return this.paths;
  }

  /**
   * Resolve fallback paths if primary paths fail
   */
  async resolvePathsFallback() {
    logger.info("Resolving fallback paths");

    // Try container paths
    this.paths.base = "/etc/traefik";
    this.paths.config = "/etc/traefik";
    this.paths.agents = "/etc/traefik/agents";
    this.paths.dynamic = "/etc/traefik/dynamic.yml";

    logger.info("Using fallback paths", { paths: this.paths });
    return this.paths;
  }

  /**
   * Get configuration templates
   */
  getConfigTemplates() {
    return {
      agent: {
        http: {
          routers: {},
          services: {},
          middlewares: {},
        },
        tcp: {
          routers: {},
          services: {},
        },
      },
      dynamic: {
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
              "web-to-websecure": {
                redirectScheme: {
                  scheme: "https",
                  permanent: true,
                },
              },
            },
            services: {},
          },
        },
        tcp: {
          routers: {
            "mongodb-catchall": {
              rule: `HostSNI(\`*.${this.domains.mongo}\`)`,
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
      },
    };
  }

  /**
   * Ensure required directories exist
   */
  async ensureDirectories() {
    const dirs = [this.paths.config, this.paths.agents];

    for (const dir of dirs) {
      try {
        await fs.mkdir(dir, { recursive: true });
        logger.debug(`Directory created: ${dir}`);
      } catch (err) {
        if (err.code !== "EEXIST") {
          logger.error(`Failed to create directory ${dir}: ${err.message}`);
          throw err;
        }
      }
    }

    return true;
  }

  /**
   * Ensure main configuration file exists and is valid
   */
  async ensureMainConfig() {
    try {
      // Check if file exists
      let config;
      try {
        const content = await fs.readFile(this.paths.dynamic, "utf8");
        config = yaml.parse(content);
        logger.debug("Main configuration file loaded");
      } catch (err) {
        if (err.code === "ENOENT") {
          // File doesn't exist, create it
          logger.info(
            "Main configuration file not found, creating from template"
          );
          config = this.templates.dynamic;
        } else {
          logger.error(`Error reading main configuration: ${err.message}`);
          // Assume corrupted file, create backup and use template
          try {
            const backupPath = `${this.paths.dynamic}.backup.${Date.now()}`;
            await fs.copyFile(this.paths.dynamic, backupPath);
            logger.info(
              `Created backup of corrupted configuration at ${backupPath}`
            );
          } catch (backupErr) {
            // Ignore if we can't create a backup
          }
          config = this.templates.dynamic;
        }
      }

      // Validate and fix structure
      config = this.ensureConfigStructure(config);
      this.configs.main = config;

      // Write the file
      await this.saveConfig(this.paths.dynamic, config);
      logger.info("Main configuration file validated and saved");

      return config;
    } catch (err) {
      logger.error(`Failed to ensure main configuration: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      throw err;
    }
  }

  /**
   * Ensure agent configurations are valid
   */
  async validateAgentConfigs() {
    try {
      // Get list of agent configuration files
      let files;
      try {
        files = await fs.readdir(this.paths.agents);
      } catch (err) {
        if (err.code === "ENOENT") {
          // Directory doesn't exist
          await this.ensureDirectories();
          return [];
        }
        throw err;
      }

      // Filter for YAML files
      const agentFiles = files.filter(
        (file) => file.endsWith(".yml") && file !== "default.yml"
      );

      // Process each agent file
      for (const file of agentFiles) {
        const agentId = file.replace(".yml", "");
        const filePath = path.join(this.paths.agents, file);

        try {
          // Read and parse file
          const content = await fs.readFile(filePath, "utf8");
          let config = yaml.parse(content);

          // Validate and fix structure
          config = this.ensureAgentConfigStructure(config);

          // Cache the configuration
          this.configs.agents.set(agentId, config);

          logger.debug(`Agent configuration validated: ${agentId}`);
        } catch (err) {
          logger.error(
            `Error with agent configuration ${agentId}: ${err.message}`
          );

          // Create a backup and reset
          try {
            const backupPath = `${filePath}.backup.${Date.now()}`;
            await fs.copyFile(filePath, backupPath);
            logger.info(
              `Created backup of corrupted agent configuration at ${backupPath}`
            );

            // Write a fresh template
            await this.saveConfig(filePath, this.templates.agent);
            this.configs.agents.set(agentId, this.templates.agent);

            logger.info(`Reset agent configuration: ${agentId}`);
          } catch (backupErr) {
            logger.error(
              `Failed to backup/reset agent configuration: ${backupErr.message}`
            );
          }
        }
      }

      logger.info(`Validated ${agentFiles.length} agent configurations`);
      return agentFiles;
    } catch (err) {
      logger.error(`Failed to validate agent configurations: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      throw err;
    }
  }

  /**
   * Verify write permissions by creating a test file
   */
  async verifyWritePermissions() {
    const testPath = path.join(this.paths.agents, "test-permissions.tmp");

    try {
      // Write test file
      await fs.writeFile(testPath, "test", "utf8");

      // Remove test file
      await fs.unlink(testPath);

      logger.debug("Write permissions verified");
      return true;
    } catch (err) {
      logger.error(`Failed to verify write permissions: ${err.message}`, {
        path: testPath,
        error: err.message,
      });
      throw err;
    }
  }

  /**
   * Ensure config has the required structure
   */
  ensureConfigStructure(config) {
    // Create a deep copy to avoid modifying the original
    const result = JSON.parse(JSON.stringify(config || {}));

    // Ensure HTTP section
    result.http = result.http || {};
    result.http.routers = result.http.routers || {};
    result.http.services = result.http.services || {};
    result.http.middlewares = result.http.middlewares || {};

    // Ensure web-to-websecure middleware
    if (!result.http.middlewares["web-to-websecure"]) {
      result.http.middlewares["web-to-websecure"] =
        this.templates.dynamic.http.middlewares["web-to-websecure"];
    }

    // Ensure TCP section for MongoDB
    result.tcp = result.tcp || {};
    result.tcp.routers = result.tcp.routers || {};
    result.tcp.services = result.tcp.services || {};

    // Ensure MongoDB catchall router
    if (!result.tcp.routers["mongodb-catchall"]) {
      result.tcp.routers["mongodb-catchall"] =
        this.templates.dynamic.tcp.routers["mongodb-catchall"];
    }

    // Ensure MongoDB catchall service
    if (!result.tcp.services["mongodb-catchall-service"]) {
      result.tcp.services["mongodb-catchall-service"] =
        this.templates.dynamic.tcp.services["mongodb-catchall-service"];
    }

    return result;
  }

  /**
   * Ensure agent config has the required structure
   */
  ensureAgentConfigStructure(config) {
    // Create a deep copy to avoid modifying the original
    const result = JSON.parse(JSON.stringify(config || {}));

    // Ensure HTTP section
    result.http = result.http || {};
    result.http.routers = result.http.routers || {};
    result.http.services = result.http.services || {};
    result.http.middlewares = result.http.middlewares || {};

    // Ensure TCP section
    result.tcp = result.tcp || {};
    result.tcp.routers = result.tcp.routers || {};
    result.tcp.services = result.tcp.services || {};

    return result;
  }

  /**
   * Save configuration to file
   */
  async saveConfig(filePath, config) {
    try {
      // Format YAML with proper indentation
      const yamlStr = yaml.stringify(config, {
        indent: 2,
        aliasDuplicateObjects: false,
      });

      // Make backup if file exists
      try {
        const stats = await fs.stat(filePath);
        if (stats.isFile()) {
          const backupPath = `${filePath}.backup.${Date.now()}`;
          await fs.copyFile(filePath, backupPath);
          logger.debug(`Created backup at ${backupPath}`);
        }
      } catch (err) {
        // Ignore if file doesn't exist
      }

      // Write file
      await fs.writeFile(filePath, yamlStr, "utf8");
      logger.debug(`Configuration saved: ${filePath}`);

      return true;
    } catch (err) {
      logger.error(`Failed to save configuration: ${err.message}`, {
        path: filePath,
        error: err.message,
        stack: err.stack,
      });
      throw err;
    }
  }

  /**
   * Get agent configuration
   */
  async getAgentConfig(agentId) {
    if (!this.initialized) {
      await this.initialize();
    }

    // Check cache first
    if (this.configs.agents.has(agentId)) {
      return this.configs.agents.get(agentId);
    }

    // Load from file
    const filePath = path.join(this.paths.agents, `${agentId}.yml`);

    try {
      const content = await fs.readFile(filePath, "utf8");
      let config = yaml.parse(content);

      // Validate structure
      config = this.ensureAgentConfigStructure(config);

      // Cache the configuration
      this.configs.agents.set(agentId, config);

      return config;
    } catch (err) {
      if (err.code === "ENOENT") {
        // File doesn't exist, create a new one
        const config = this.templates.agent;

        // Cache the configuration
        this.configs.agents.set(agentId, config);

        return config;
      }

      logger.error(`Failed to get agent configuration: ${err.message}`, {
        agentId,
        error: err.message,
        stack: err.stack,
      });
      throw err;
    }
  }

  /**
   * Save agent configuration
   */
  async saveAgentConfig(agentId, config) {
    if (!this.initialized) {
      await this.initialize();
    }

    // Validate structure
    config = this.ensureAgentConfigStructure(config);

    // Cache the configuration
    this.configs.agents.set(agentId, config);

    // Save to file
    const filePath = path.join(this.paths.agents, `${agentId}.yml`);
    await this.saveConfig(filePath, config);

    return true;
  }

  /**
   * List all agent IDs
   */
  async listAgents() {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const files = await fs.readdir(this.paths.agents);
      return files
        .filter((file) => file.endsWith(".yml") && file !== "default.yml")
        .map((file) => file.replace(".yml", ""));
    } catch (err) {
      logger.error(`Failed to list agents: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return [];
    }
  }

  /**
   * Remove agent configuration
   */
  async removeAgentConfig(agentId) {
    if (!this.initialized) {
      await this.initialize();
    }

    // Remove from cache
    this.configs.agents.delete(agentId);

    // Remove file
    const filePath = path.join(this.paths.agents, `${agentId}.yml`);

    try {
      await fs.unlink(filePath);
      logger.info(`Removed agent configuration: ${agentId}`);
      return true;
    } catch (err) {
      if (err.code === "ENOENT") {
        // File doesn't exist, consider it removed
        return true;
      }

      logger.error(`Failed to remove agent configuration: ${err.message}`, {
        agentId,
        error: err.message,
        stack: err.stack,
      });
      return false;
    }
  }

  /**
   * Repair all configuration files
   */
  async repairAllConfigurations() {
    logger.info("Starting emergency repair of all configurations");

    // Re-initialize with clean state
    this.initialized = false;
    this.configs.agents.clear();
    this.configs.main = null;

    // Initialize again
    await this.initialize();

    // Get all agent IDs
    const agents = await this.listAgents();

    // Reset each agent to template
    for (const agentId of agents) {
      await this.saveAgentConfig(agentId, this.templates.agent);
    }

    logger.info("Emergency repair completed");
    return true;
  }
}

module.exports = new ConfigManager();
