/**
 * Configuration Service
 *
 * Single source of truth for all configuration management.
 * Handles loading, saving, and validating configuration files.
 */

const fs = require("fs").promises;
const path = require("path");
const yaml = require("yaml");
const logger = require("../../utils/logger").getLogger("configService");
const pathManager = require("../../utils/pathManager");

class ConfigService {
  constructor() {
    // Configuration paths
    this.paths = {
      base: process.env.CONFIG_BASE_PATH || "/app/config",
      agents: process.env.AGENTS_CONFIG_DIR || "/app/config/agents",
      dynamic: process.env.DYNAMIC_CONFIG_PATH || "/app/config/dynamic.yml",
      traefik: process.env.TRAEFIK_CONFIG_PATH || "/app/config/traefik.yml",
      docker: process.env.DOCKER_COMPOSE_PATH || "/app/docker-compose.yml",
    };

    // Configuration domains
    this.domains = {
      mongo: process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk",
      app: process.env.APP_DOMAIN || "apps.cloudlunacy.uk",
    };

    // Configuration templates
    this.templates = {
      agent: null,
      dynamic: null,
      traefik: null,
    };

    // Loaded configurations
    this.configs = {
      agents: new Map(),
      main: null,
      traefik: null,
    };

    this.initialized = false;
  }

  /**
   * Initialize the configuration service
   */
  async initialize() {
    if (this.initialized) {
      return true;
    }

    try {
      logger.info("Initializing configuration service");

      // Initialize path manager if needed
      if (!pathManager.initialized) {
        await pathManager.initialize();
      }

      // Ensure configuration directories exist
      await pathManager.ensureDirectory(this.paths.base);
      await pathManager.ensureDirectory(this.paths.agents);

      // Load main configuration
      await this.loadMainConfig();

      this.initialized = true;
      logger.info("Configuration service initialized successfully");
      return true;
    } catch (err) {
      logger.error(
        `Failed to initialize configuration service: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
        }
      );

      // Try recovery with fallback paths
      try {
        logger.info("Attempting recovery with fallback paths");
        await this.resolvePathsFallback();
        await this.ensureDirectories();
        await this.loadMainConfig();

        this.initialized = true;
        logger.info("Configuration service initialized with fallback paths");
        return true;
      } catch (recoveryErr) {
        logger.error(`Recovery failed: ${recoveryErr.message}`);
        throw err;
      }
    }
  }

  /**
   * Resolve configuration paths
   */
  async resolvePaths() {
    try {
      // Resolve base config path
      this.paths.base = await pathManager.resolvePath("config");

      // Resolve other paths based on base path
      this.paths.agents = path.join(this.paths.base, "agents");
      this.paths.dynamic = path.join(this.paths.base, "dynamic.yml");
      this.paths.traefik = path.join(this.paths.base, "traefik.yml");

      logger.debug("Resolved configuration paths", { paths: this.paths });
      return true;
    } catch (err) {
      logger.error(`Failed to resolve paths: ${err.message}`);
      throw err;
    }
  }

  /**
   * Fallback path resolution for recovery
   */
  async resolvePathsFallback() {
    // Use hardcoded paths as fallback
    this.paths.base = "/app/config";
    this.paths.agents = "/app/config/agents";
    this.paths.dynamic = "/app/config/dynamic.yml";
    this.paths.traefik = "/app/config/traefik.yml";

    logger.debug("Using fallback configuration paths", { paths: this.paths });
    return true;
  }

  /**
   * Ensure required directories exist
   */
  async ensureDirectories() {
    try {
      // Ensure base config directory exists
      await pathManager.ensureDirectory(this.paths.base);

      // Ensure agents directory exists
      await pathManager.ensureDirectory(this.paths.agents);

      return true;
    } catch (err) {
      logger.error(`Failed to ensure directories: ${err.message}`);
      throw err;
    }
  }

  /**
   * Load configuration templates
   */
  loadTemplates() {
    // Agent template
    this.templates.agent = {
      http: { routers: {}, services: {}, middlewares: {} },
      tcp: { routers: {}, services: {} },
    };

    // Dynamic config template
    this.templates.dynamic = {
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
    };

    logger.debug("Loaded configuration templates");
  }

  /**
   * Load main configuration
   */
  async loadMainConfig() {
    try {
      // Try to read dynamic.yml
      try {
        const content = await fs.readFile(this.paths.dynamic, "utf8");
        this.configs.main = yaml.parse(content);
        logger.debug("Loaded main configuration from file");
      } catch (err) {
        // If file doesn't exist or is invalid, use template
        logger.warn(`Failed to load main configuration: ${err.message}`);
        logger.info("Using template for main configuration");
        this.configs.main = this.templates.dynamic;

        // Save the template to file
        await this.saveConfig(this.paths.dynamic, this.configs.main);
      }

      return true;
    } catch (err) {
      logger.error(`Failed to load main configuration: ${err.message}`);
      throw err;
    }
  }

  /**
   * Save configuration to file
   */
  async saveConfig(filePath, config) {
    try {
      const content = yaml.stringify(config);
      await fs.writeFile(filePath, content, "utf8");
      logger.debug(`Saved configuration to ${filePath}`);
      return true;
    } catch (err) {
      logger.error(
        `Failed to save configuration to ${filePath}: ${err.message}`
      );
      throw err;
    }
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
   * Repair all configurations
   */
  async repair() {
    logger.info("Repairing all configurations");

    // Reset state
    this.initialized = false;
    this.configs.agents.clear();
    this.configs.main = null;

    // Re-initialize
    await this.initialize();

    // Save main config from template
    await this.saveConfig(this.paths.dynamic, this.templates.dynamic);

    logger.info("Configuration repair completed");
    return true;
  }

  /**
   * Update a TCP router in the configuration
   * @param {string} name - Router name
   * @param {object} config - Router configuration
   */
  async updateTcpRouter(name, config) {
    try {
      logger.debug(`Updating TCP router: ${name}`);
      await this.initialize();

      // Make sure main config is loaded
      if (!this.configs.main) {
        await this.loadMainConfig();
      }

      // Ensure tcp section exists
      if (!this.configs.main.tcp) {
        this.configs.main.tcp = { routers: {}, services: {} };
      }
      if (!this.configs.main.tcp.routers) {
        this.configs.main.tcp.routers = {};
      }

      // Update or add the router
      this.configs.main.tcp.routers[name] = config;

      // Save the configuration
      await this.saveConfiguration();
      logger.info(`TCP router ${name} updated successfully`);
      return true;
    } catch (err) {
      logger.error(`Failed to update TCP router ${name}: ${err.message}`, {
        error: err.message,
        stack: err.stack,
        name,
      });
      throw err;
    }
  }

  /**
   * Update a TCP service in the configuration
   * @param {string} name - Service name
   * @param {object} config - Service configuration
   */
  async updateTcpService(name, config) {
    try {
      logger.debug(`Updating TCP service: ${name}`);
      await this.initialize();

      // Make sure main config is loaded
      if (!this.configs.main) {
        await this.loadMainConfig();
      }

      // Ensure tcp section exists
      if (!this.configs.main.tcp) {
        this.configs.main.tcp = { routers: {}, services: {} };
      }
      if (!this.configs.main.tcp.services) {
        this.configs.main.tcp.services = {};
      }

      // Update or add the service
      this.configs.main.tcp.services[name] = config;

      // Save the configuration
      await this.saveConfiguration();
      logger.info(`TCP service ${name} updated successfully`);
      return true;
    } catch (err) {
      logger.error(`Failed to update TCP service ${name}: ${err.message}`, {
        error: err.message,
        stack: err.stack,
        name,
      });
      throw err;
    }
  }

  /**
   * Save the configuration
   */
  async saveConfiguration() {
    return this.saveConfig(this.paths.dynamic, this.configs.main);
  }
}

module.exports = new ConfigService();
