// utils/configManager.js
const fs = require("fs").promises;
const path = require("path");
const yaml = require("yaml");
const logger = require("./logger").getLogger("configManager");

class ConfigManager {
  constructor() {
    // Make sure paths match Docker volume mounts
    this.baseConfigPath =
      process.env.CONFIG_BASE_PATH || "/opt/cloudlunacy_front/config";
    this.agentsConfigDir = path.join(this.baseConfigPath, "agents");
    this.mainDynamicConfigPath = path.join(this.baseConfigPath, "dynamic.yml");

    // Track if initialization is complete
    this.initialized = false;

    // Add path to save directly to Traefik container as fallback
    this.traefikConfigDir = "/etc/traefik";
    this.traefikAgentsDir = path.join(this.traefikConfigDir, "agents");
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
      throw err;
    }
  }

  async ensureDirectory(dirPath) {
    try {
      const stats = await fs.stat(dirPath);
      if (!stats.isDirectory()) {
        logger.error(`Path ${dirPath} exists but is not a directory`);
        throw new Error(`${dirPath} is not a directory`);
      }
      logger.info(`Directory exists: ${dirPath}`);
    } catch (err) {
      if (err.code === "ENOENT") {
        logger.info(`Creating directory: ${dirPath}`);
        await fs.mkdir(dirPath, { recursive: true });
        // Set proper permissions
        await fs.chmod(dirPath, 0o755);
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
    } catch (err) {
      logger.error("Failed to ensure main config:", err);
      throw err;
    }
  }

  getDefaultMainConfig() {
    return {
      http: {
        routers: {},
        services: {},
        middlewares: {
          "web-to-websecure": {
            redirectScheme: {
              scheme: "https",
              permanent: true,
            },
          },
        },
      },
      tcp: {
        routers: {
          "mongodb-catchall": {
            rule: "HostSNI(`*.mongodb.cloudlunacy.uk`)",
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
    const newConfig = JSON.parse(JSON.stringify(config));

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
        rule: "HostSNI(`*.mongodb.cloudlunacy.uk`)",
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
      const agentFiles = await fs.readdir(this.agentsConfigDir);
      logger.info(`Found ${agentFiles.length} agent configuration files`);

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
    const newConfig = JSON.parse(JSON.stringify(config));

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
      throw testErr;
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
}

module.exports = new ConfigManager();
