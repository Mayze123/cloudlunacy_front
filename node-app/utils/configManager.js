// utils/configManager.js - Fixed version

const fs = require("fs").promises;
const path = require("path");
const yaml = require("yaml");

// First, get a simple console logger before trying to load the proper logger
const consoleLogger = {
  info: (msg, meta) => console.log(`[INFO] ${msg}`, meta || ""),
  warn: (msg, meta) => console.warn(`[WARN] ${msg}`, meta || ""),
  error: (msg, meta) => console.error(`[ERROR] ${msg}`, meta || ""),
  debug: (msg, meta) => console.log(`[DEBUG] ${msg}`, meta || ""),
};

// Try to load the real logger, fallback to console logger if it fails
let logger;
try {
  logger = require("./logger").getLogger("configManager");
} catch (err) {
  console.warn(`Could not load logger module: ${err.message}`);
  console.warn("Using fallback console logger");
  logger = consoleLogger;
}

class ConfigManager {
  constructor() {
    // Initialize with default paths
    this.baseConfigPath =
      process.env.CONFIG_BASE_PATH || "/opt/cloudlunacy_front/config";

    // Add fallback paths for Docker environment
    const possibleConfigPaths = [
      this.baseConfigPath,
      "/app/config",
      "/etc/traefik",
      path.join(process.cwd(), "config"),
    ];

    // Find the first existing config path
    for (const configPath of possibleConfigPaths) {
      try {
        if (require("fs").existsSync(configPath)) {
          this.baseConfigPath = configPath;
          break;
        }
      } catch (err) {
        // Skip if path check fails
      }
    }

    this.agentsConfigDir = path.join(this.baseConfigPath, "agents");
    this.mainDynamicConfigPath = path.join(this.baseConfigPath, "dynamic.yml");

    // Add path to save directly to Traefik container as fallback
    this.traefikConfigDir = "/etc/traefik";
    this.traefikAgentsDir = path.join(this.traefikConfigDir, "agents");

    // Set MongoDB domain from environment
    this.mongoDomain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";

    // Track if initialization is complete
    this.initialized = false;

    // Log initialized paths
    console.log(
      `ConfigManager initialized with baseConfigPath: ${this.baseConfigPath}`
    );
    console.log(`agentsConfigDir: ${this.agentsConfigDir}`);
    console.log(`mainDynamicConfigPath: ${this.mainDynamicConfigPath}`);
  }

  async initialize() {
    try {
      logger.info(
        `Initializing config manager with base path: ${this.baseConfigPath}`
      );
      logger.info(`Agents config directory: ${this.agentsConfigDir}`);

      // Ensure directories exist
      await this.ensureDirectory(this.baseConfigPath);
      await this.ensureDirectory(this.agentsConfigDir);

      // Ensure main config exists with correct structure
      await this.ensureMainConfig();

      // Scan and validate existing agent configs
      await this.validateAgentConfigs();

      // Create test file to verify write permissions
      await this.verifyWritePermissions();

      this.initialized = true;
      logger.info("Configuration manager initialized successfully");
      return true;
    } catch (err) {
      logger.error("Failed to initialize config manager:", err);

      // Try to recover by using fallback paths
      try {
        logger.info("Attempting recovery with fallback paths");

        // Try fallback to Traefik container path
        this.baseConfigPath = this.traefikConfigDir;
        this.agentsConfigDir = this.traefikAgentsDir;
        this.mainDynamicConfigPath = path.join(
          this.traefikConfigDir,
          "dynamic.yml"
        );

        logger.info(`Fallback: using baseConfigPath: ${this.baseConfigPath}`);

        // Ensure directories exist in fallback location
        await this.ensureDirectory(this.baseConfigPath);
        await this.ensureDirectory(this.agentsConfigDir);

        // Ensure main config exists with correct structure
        await this.ensureMainConfig();

        this.initialized = true;
        logger.info(
          "Configuration manager initialized successfully with fallback paths"
        );
        return true;
      } catch (recoveryErr) {
        logger.error("Recovery attempt also failed:", recoveryErr);
        throw err;
      }
    }
  }

  async ensureDirectory(dirPath) {
    try {
      const stats = await fs.stat(dirPath).catch(() => null);

      if (!stats) {
        logger.info(`Creating directory: ${dirPath}`);
        await fs.mkdir(dirPath, { recursive: true });
        // Set proper permissions
        await fs.chmod(dirPath, 0o755);
        return;
      }

      if (!stats.isDirectory()) {
        logger.error(`Path ${dirPath} exists but is not a directory`);
        throw new Error(`${dirPath} is not a directory`);
      }

      logger.info(`Directory exists: ${dirPath}`);
    } catch (err) {
      // Handle the case where parent directory doesn't exist
      if (err.code === "ENOENT") {
        try {
          logger.info(`Creating directory with parent directories: ${dirPath}`);
          await fs.mkdir(dirPath, { recursive: true });
          // Set proper permissions
          await fs.chmod(dirPath, 0o755);
        } catch (mkdirErr) {
          logger.error(`Failed to create directory ${dirPath}:`, mkdirErr);
          throw mkdirErr;
        }
      } else {
        logger.error(`Error checking directory ${dirPath}:`, err);
        throw err;
      }
    }
  }

  async ensureMainConfig() {
    try {
      let mainConfig;
      try {
        const content = await fs.readFile(this.mainDynamicConfigPath, "utf8");
        logger.info("Main dynamic config file read successfully");

        try {
          mainConfig = yaml.parse(content) || {};
          logger.info("Main dynamic config file parsed successfully");
        } catch (parseErr) {
          logger.error(`Error parsing main config file: ${parseErr.message}`);
          // Create a backup of the corrupted file
          const backupPath = `${
            this.mainDynamicConfigPath
          }.corrupted.${Date.now()}`;
          await fs.copyFile(this.mainDynamicConfigPath, backupPath);
          logger.info(`Corrupted config backed up to ${backupPath}`);

          // Create a new default config
          mainConfig = this.getDefaultMainConfig();
        }
      } catch (err) {
        if (err.code === "ENOENT") {
          logger.info(
            "Main dynamic config file does not exist, creating default config"
          );
          mainConfig = this.getDefaultMainConfig();
        } else {
          logger.error(`Error reading main config file: ${err.message}`);
          throw err;
        }
      }

      // Ensure necessary sections exist
      mainConfig = this.ensureConfigStructure(mainConfig);

      // Save the config
      await this.saveConfig(this.mainDynamicConfigPath, mainConfig);
      logger.info("Main dynamic config file saved successfully");

      // Double-check the saved file to ensure it's valid YAML
      await this.validateYamlFile(this.mainDynamicConfigPath);
    } catch (err) {
      logger.error("Failed to ensure main config:", err);
      throw err;
    }
  }

  /**
   * Validate that a YAML file is properly formatted
   */
  async validateYamlFile(filePath) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      try {
        yaml.parse(content);
        logger.info(`YAML validation successful for ${filePath}`);
        return true;
      } catch (parseErr) {
        logger.error(
          `YAML validation failed for ${filePath}: ${parseErr.message}`
        );

        // Try to repair the file
        logger.info(`Attempting to repair malformed YAML file: ${filePath}`);

        // Create a backup
        const backupPath = `${filePath}.malformed.${Date.now()}`;
        await fs.copyFile(filePath, backupPath);

        // For main config, use default template
        if (filePath === this.mainDynamicConfigPath) {
          const fixedConfig = this.getDefaultMainConfig();
          await this.saveConfig(filePath, fixedConfig);
          logger.info(`Repaired main config file with default template`);
        } else {
          // For agent configs, use default agent template
          const fixedConfig = this.getDefaultAgentConfig();
          await this.saveConfig(filePath, fixedConfig);
          logger.info(`Repaired agent config file with default template`);
        }

        return false;
      }
    } catch (readErr) {
      logger.error(
        `Error reading file for validation ${filePath}: ${readErr.message}`
      );
      return false;
    }
  }

  getDefaultMainConfig() {
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
            rule: `HostSNI(\`*.${this.mongoDomain}\`)`,
            service: "mongodb-catchall-service",
            entryPoints: ["mongodb"],
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

  ensureConfigStructure(config) {
    // Create a deep copy to avoid modifying the original
    const newConfig = JSON.parse(JSON.stringify(config || {}));

    // Ensure HTTP structure
    newConfig.http = newConfig.http || {};
    newConfig.http.routers = newConfig.http.routers || {};
    newConfig.http.services = newConfig.http.services || {};
    newConfig.http.middlewares = newConfig.http.middlewares || {};

    // Ensure web-to-websecure middleware exists
    if (!newConfig.http.middlewares["web-to-websecure"]) {
      newConfig.http.middlewares["web-to-websecure"] = {
        redirectScheme: {
          scheme: "https",
          permanent: true,
        },
      };
    }

    // Ensure TCP structure for MongoDB
    newConfig.tcp = newConfig.tcp || {};
    newConfig.tcp.routers = newConfig.tcp.routers || {};
    newConfig.tcp.services = newConfig.tcp.services || {};

    // Ensure MongoDB catchall router exists
    if (!newConfig.tcp.routers["mongodb-catchall"]) {
      newConfig.tcp.routers["mongodb-catchall"] = {
        rule: `HostSNI(\`*.${this.mongoDomain}\`)`,
        service: "mongodb-catchall-service",
        entryPoints: ["mongodb"],
        tls: {
          passthrough: true,
        },
      };
    }

    // Ensure MongoDB catchall service exists
    if (!newConfig.tcp.services["mongodb-catchall-service"]) {
      newConfig.tcp.services["mongodb-catchall-service"] = {
        loadBalancer: {
          servers: [],
        },
      };
    }

    return newConfig;
  }

  async validateAgentConfigs() {
    try {
      let agentFiles = [];
      try {
        agentFiles = await fs.readdir(this.agentsConfigDir);
        logger.info(`Found ${agentFiles.length} agent configuration files`);
      } catch (readErr) {
        if (readErr.code === "ENOENT") {
          // Directory doesn't exist yet, create it
          await this.ensureDirectory(this.agentsConfigDir);
          logger.info("Created agents directory that was missing");
          return;
        } else {
          throw readErr;
        }
      }

      for (const file of agentFiles) {
        if (file.endsWith(".yml")) {
          const agentPath = path.join(this.agentsConfigDir, file);
          try {
            const agentContent = await fs.readFile(agentPath, "utf8");
            try {
              const agentConfig = yaml.parse(agentContent);
              logger.info(`Agent config ${file} is valid`);

              // Ensure agent config has proper structure
              const updatedConfig =
                this.ensureAgentConfigStructure(agentConfig);
              if (
                JSON.stringify(updatedConfig) !== JSON.stringify(agentConfig)
              ) {
                logger.info(`Updating structure of agent config ${file}`);
                await this.saveConfig(agentPath, updatedConfig);
              }
            } catch (parseErr) {
              logger.error(
                `Error parsing agent config ${file}: ${parseErr.message}`
              );
              // Create a backup and fix
              const backupPath = `${agentPath}.corrupted.${Date.now()}`;
              await fs.copyFile(agentPath, backupPath);
              logger.info(`Corrupted agent config backed up to ${backupPath}`);

              // Create a new default config for this agent
              const defaultAgentConfig = this.getDefaultAgentConfig();
              await this.saveConfig(agentPath, defaultAgentConfig);
              logger.info(`Reset agent config ${file} to defaults`);
            }
          } catch (readErr) {
            logger.error(
              `Error reading agent config ${file}: ${readErr.message}`
            );
          }
        }
      }
    } catch (err) {
      // If there's an error listing files, it might be because the directory was just created
      if (err.code !== "ENOENT") {
        logger.error(`Error scanning agent configs: ${err.message}`);
      }
    }
  }

  getDefaultAgentConfig() {
    return {
      http: {
        routers: {},
        services: {},
        middlewares: {},
      },
      tcp: {
        routers: {},
        services: {},
      },
    };
  }

  ensureAgentConfigStructure(config) {
    // Create a deep copy to avoid modifying the original
    const newConfig = JSON.parse(JSON.stringify(config || {}));

    // Ensure HTTP structure
    newConfig.http = newConfig.http || {};
    newConfig.http.routers = newConfig.http.routers || {};
    newConfig.http.services = newConfig.http.services || {};
    newConfig.http.middlewares = newConfig.http.middlewares || {};

    // Ensure TCP structure
    newConfig.tcp = newConfig.tcp || {};
    newConfig.tcp.routers = newConfig.tcp.routers || {};
    newConfig.tcp.services = newConfig.tcp.services || {};

    return newConfig;
  }

  async verifyWritePermissions() {
    try {
      const testAgentPath = path.join(this.agentsConfigDir, "test-agent.yml");
      const testConfig = this.getDefaultAgentConfig();
      await this.saveConfig(testAgentPath, testConfig);
      logger.info("Test agent config created successfully");

      // Remove the test file
      await fs.unlink(testAgentPath);
      logger.info("Test agent config removed successfully");
    } catch (testErr) {
      logger.error(`Failed to create test agent config: ${testErr.message}`);

      // Try writing to fallback location
      try {
        const fallbackPath = path.join(this.traefikAgentsDir, "test-agent.yml");
        logger.info(`Trying fallback path ${fallbackPath}`);

        // Ensure fallback directory exists
        await this.ensureDirectory(this.traefikAgentsDir);

        const testConfig = this.getDefaultAgentConfig();
        await this.saveConfig(fallbackPath, testConfig);
        logger.info("Test agent config created successfully at fallback path");

        // Remove the test file
        await fs.unlink(fallbackPath);
        logger.info("Test agent config removed from fallback path");

        // Switch to using fallback paths
        this.baseConfigPath = this.traefikConfigDir;
        this.agentsConfigDir = this.traefikAgentsDir;
        this.mainDynamicConfigPath = path.join(
          this.traefikConfigDir,
          "dynamic.yml"
        );

        logger.info(
          `Switched to using fallback paths due to permission issues`
        );
      } catch (fallbackErr) {
        logger.error(
          `Failed to create test agent config at fallback path: ${fallbackErr.message}`
        );
        throw testErr;
      }
    }
  }

  async getAgentConfigPath(agentId) {
    // Sanitize the agent ID to ensure it's safe for filesystem
    const safeAgentId = agentId.replace(/[^a-zA-Z0-9-_]/g, "_");
    return path.join(this.agentsConfigDir, `${safeAgentId}.yml`);
  }

  async getAgentConfig(agentId) {
    if (!this.initialized) {
      await this.initialize();
    }

    const configPath = await this.getAgentConfigPath(agentId);

    try {
      const content = await fs.readFile(configPath, "utf8");
      let config = yaml.parse(content) || this.getDefaultAgentConfig();

      // Ensure proper structure
      config = this.ensureAgentConfigStructure(config);

      return config;
    } catch (err) {
      // Return empty config if file doesn't exist
      return this.getDefaultAgentConfig();
    }
  }

  async saveAgentConfig(agentId, config) {
    if (!this.initialized) {
      await this.initialize();
    }

    const configPath = await this.getAgentConfigPath(agentId);
    logger.info(`Saving agent config for ${agentId} to ${configPath}`);

    // Ensure proper structure before saving
    const structuredConfig = this.ensureAgentConfigStructure(config);

    try {
      await this.saveConfig(configPath, structuredConfig);
      logger.info(`Successfully saved config to ${configPath}`);

      // Validate the YAML after writing
      await this.validateYamlFile(configPath);

      return true;
    } catch (err) {
      logger.error(`Error saving config to ${configPath}: ${err.message}`);

      // Try fallback path
      const fallbackPath = path.join(this.traefikAgentsDir, `${agentId}.yml`);
      try {
        logger.info(`Attempting fallback save to ${fallbackPath}`);
        await this.ensureDirectory(path.dirname(fallbackPath));
        await this.saveConfig(fallbackPath, structuredConfig);
        logger.info(`Fallback save succeeded to ${fallbackPath}`);

        // Validate the YAML after writing
        await this.validateYamlFile(fallbackPath);

        return true;
      } catch (fallbackErr) {
        logger.error(`Fallback save also failed: ${fallbackErr.message}`);
        throw err;
      }
    }
  }

  async saveConfig(configPath, config) {
    // Ensure the directory exists
    await this.ensureDirectory(path.dirname(configPath));

    // Format YAML with clean indentation and no duplicate references
    const yamlStr = yaml.stringify(config, {
      indent: 2,
      aliasDuplicateObjects: false,
    });

    await fs.writeFile(configPath, yamlStr, "utf8");

    // Set proper permissions
    await fs.chmod(configPath, 0o644);

    logger.info(`Config saved to ${configPath}`);
    return true;
  }

  async listAgents() {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const files = await fs.readdir(this.agentsConfigDir);
      return files
        .filter((file) => file.endsWith(".yml"))
        .map((file) => file.replace(".yml", ""));
    } catch (err) {
      logger.error("Failed to list agents:", err);
      return [];
    }
  }

  async removeAgentConfig(agentId) {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const configPath = await this.getAgentConfigPath(agentId);
      await fs.unlink(configPath);
      logger.info(`Removed config for agent ${agentId}`);
      return true;
    } catch (err) {
      logger.error(`Failed to remove agent ${agentId} config:`, err);
      return false;
    }
  }

  /**
   * Repair all configuration files - utility method for emergency fixes
   */
  async repairAllConfigurations() {
    logger.info("Starting emergency repair of all configuration files");

    // Fix main configuration
    try {
      logger.info("Repairing main dynamic configuration");
      const mainConfig = this.getDefaultMainConfig();
      await this.saveConfig(this.mainDynamicConfigPath, mainConfig);
      logger.info("Main configuration repaired successfully");

      // Also try to write to the Traefik container path
      try {
        const traefikMainPath = path.join(this.traefikConfigDir, "dynamic.yml");
        await this.saveConfig(traefikMainPath, mainConfig);
        logger.info(
          `Also wrote config to Traefik container path: ${traefikMainPath}`
        );
      } catch (containerErr) {
        logger.warn(
          `Could not write to Traefik container path: ${containerErr.message}`
        );
      }
    } catch (mainErr) {
      logger.error(`Failed to repair main configuration: ${mainErr.message}`);
    }

    // Repair all agent configurations
    try {
      const agents = await this.listAgents();
      logger.info(`Found ${agents.length} agent configurations to repair`);

      for (const agent of agents) {
        try {
          logger.info(`Repairing configuration for agent: ${agent}`);
          const agentConfig = this.getDefaultAgentConfig();
          await this.saveAgentConfig(agent, agentConfig);
          logger.info(`Agent ${agent} configuration repaired successfully`);
        } catch (agentErr) {
          logger.error(
            `Failed to repair agent ${agent} configuration: ${agentErr.message}`
          );
        }
      }
    } catch (scanErr) {
      logger.error(
        `Failed to scan for agent configurations: ${scanErr.message}`
      );
    }

    logger.info("Configuration repair process completed");
    return true;
  }
}

module.exports = new ConfigManager();
