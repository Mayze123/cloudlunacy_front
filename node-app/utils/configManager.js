// utils/configManager.js (new file for front server)
const fs = require("fs").promises;
const path = require("path");
const yaml = require("yaml");
const logger = require("./logger");

class ConfigManager {
  constructor() {
    this.baseConfigPath =
      process.env.CONFIG_BASE_PATH || "/opt/cloudlunacy_front/config";
    this.agentsConfigDir = path.join(this.baseConfigPath, "agents");
    this.mainDynamicConfigPath = path.join(this.baseConfigPath, "dynamic.yml");
  }

  async initialize() {
    try {
      // Add more detailed logging
      logger.info(
        `Initializing config manager with base path: ${this.baseConfigPath}`
      );
      logger.info(`Agents config directory: ${this.agentsConfigDir}`);

      // Check if base config path exists before trying to create it
      try {
        const baseStats = await fs.stat(this.baseConfigPath);
        if (!baseStats.isDirectory()) {
          logger.error(
            `Base config path ${this.baseConfigPath} exists but is not a directory`
          );
          throw new Error(`${this.baseConfigPath} is not a directory`);
        }
        logger.info(`Base config directory exists: ${this.baseConfigPath}`);
      } catch (err) {
        if (err.code === "ENOENT") {
          logger.info(`Creating base config directory: ${this.baseConfigPath}`);
          await fs.mkdir(this.baseConfigPath, { recursive: true });
        } else {
          logger.error(`Error checking base config path: ${err.message}`);
          throw err;
        }
      }

      // Now ensure the agents directory exists
      try {
        const agentsStats = await fs.stat(this.agentsConfigDir);
        if (!agentsStats.isDirectory()) {
          logger.error(
            `Agents directory ${this.agentsConfigDir} exists but is not a directory`
          );
          throw new Error(`${this.agentsConfigDir} is not a directory`);
        }
        logger.info(`Agents directory exists: ${this.agentsConfigDir}`);
      } catch (err) {
        if (err.code === "ENOENT") {
          logger.info(`Creating agents directory: ${this.agentsConfigDir}`);
          await fs.mkdir(this.agentsConfigDir, { recursive: true });
        } else {
          logger.error(`Error checking agents directory: ${err.message}`);
          throw err;
        }
      }

      // Ensure main config exists with correct structure
      let mainConfig;
      try {
        const content = await fs.readFile(this.mainDynamicConfigPath, "utf8");
        logger.info(`Main dynamic config file read successfully`);
        try {
          mainConfig = yaml.parse(content) || {};
          logger.info(`Main dynamic config file parsed successfully`);
        } catch (parseErr) {
          logger.error(`Error parsing main config file: ${parseErr.message}`);
          // Create a backup of the corrupted file
          const backupPath = `${
            this.mainDynamicConfigPath
          }.corrupted.${Date.now()}`;
          await fs.copyFile(this.mainDynamicConfigPath, backupPath);
          logger.info(`Corrupted config backed up to ${backupPath}`);

          // Create a new config
          mainConfig = {
            http: {
              routers: {},
              services: {},
              middlewares: {
                pingMiddleware: { ping: {} },
                "web-to-websecure": {
                  redirectScheme: {
                    scheme: "https",
                    permanent: true,
                  },
                },
              },
            },
          };
        }
      } catch (err) {
        if (err.code === "ENOENT") {
          logger.info(
            `Main dynamic config file does not exist, creating default config`
          );
          // File doesn't exist, create a default one
          mainConfig = {
            http: {
              routers: {},
              services: {},
              middlewares: {
                pingMiddleware: { ping: {} },
                "web-to-websecure": {
                  redirectScheme: {
                    scheme: "https",
                    permanent: true,
                  },
                },
              },
            },
          };
        } else {
          logger.error(`Error reading main config file: ${err.message}`);
          throw err;
        }
      }

      // Save the main config if we had to create or fix it
      try {
        await this.saveConfig(this.mainDynamicConfigPath, mainConfig);
        logger.info(`Main dynamic config file saved successfully`);
      } catch (saveErr) {
        logger.error(`Error saving main config file: ${saveErr.message}`);
        throw saveErr;
      }

      // Scan for existing agent configs to ensure they're valid
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
              } catch (parseErr) {
                logger.error(
                  `Error parsing agent config ${file}: ${parseErr.message}`
                );
                // Create a backup and fix
                const backupPath = `${agentPath}.corrupted.${Date.now()}`;
                await fs.copyFile(agentPath, backupPath);
                logger.info(
                  `Corrupted agent config backed up to ${backupPath}`
                );

                // Create a new default config for this agent
                const defaultAgentConfig = {
                  http: { routers: {}, services: {}, middlewares: {} },
                };
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

      // Create a test agent config file to verify write access
      try {
        const testAgentPath = path.join(this.agentsConfigDir, "test-agent.yml");
        const testConfig = {
          http: { routers: {}, services: {}, middlewares: {} },
        };
        await this.saveConfig(testAgentPath, testConfig);
        logger.info(`Test agent config created successfully`);

        // Remove the test file
        await fs.unlink(testAgentPath);
        logger.info(`Test agent config removed successfully`);
      } catch (testErr) {
        logger.error(`Failed to create test agent config: ${testErr.message}`);
        throw testErr;
      }

      logger.info("Configuration manager initialized successfully");
      return true;
    } catch (err) {
      logger.error("Failed to initialize config manager:", err);
      throw err;
    }
  }

  async getAgentConfigPath(agentId) {
    // Sanitize the agent ID to ensure it's safe for filesystem
    const safeAgentId = agentId.replace(/[^a-zA-Z0-9-_]/g, "_");
    return path.join(this.agentsConfigDir, `${safeAgentId}.yml`);
  }

  async getAgentConfig(agentId) {
    const configPath = await this.getAgentConfigPath(agentId);

    try {
      const content = await fs.readFile(configPath, "utf8");
      return (
        yaml.parse(content) || {
          http: { routers: {}, services: {}, middlewares: {} },
        }
      );
    } catch (err) {
      // Return empty config if file doesn't exist
      return { http: { routers: {}, services: {}, middlewares: {} } };
    }
  }

  async saveAgentConfig(agentId, config) {
    const configPath = await this.getAgentConfigPath(agentId);
    await this.saveConfig(configPath, config);

    // Now merge all agent configs into the main dynamic.yml
    await this.mergeAgentConfigsIntoMain();

    return true;
  }

  async mergeAgentConfigsIntoMain() {
    try {
      // First, get the main configuration
      const mainConfig = await this.getMainConfig();

      // Now get all agent configurations and merge them
      const agentFiles = await fs.readdir(this.agentsConfigDir);
      for (const file of agentFiles) {
        if (file.endsWith(".yml")) {
          const agentPath = path.join(this.agentsConfigDir, file);
          const agentContent = await fs.readFile(agentPath, "utf8");
          const agentConfig = yaml.parse(agentContent);

          // Merge HTTP routers, services, middlewares
          if (agentConfig.http) {
            if (agentConfig.http.routers) {
              mainConfig.http.routers = {
                ...mainConfig.http.routers,
                ...agentConfig.http.routers,
              };
            }

            if (agentConfig.http.services) {
              mainConfig.http.services = {
                ...mainConfig.http.services,
                ...agentConfig.http.services,
              };
            }

            if (agentConfig.http.middlewares) {
              mainConfig.http.middlewares = {
                ...mainConfig.http.middlewares,
                ...agentConfig.http.middlewares,
              };
            }
          }

          // Merge TCP configuration if present
          if (agentConfig.tcp) {
            if (!mainConfig.tcp) {
              mainConfig.tcp = { routers: {}, services: {} };
            }

            if (agentConfig.tcp.routers) {
              mainConfig.tcp.routers = {
                ...mainConfig.tcp.routers,
                ...agentConfig.tcp.routers,
              };
            }

            if (agentConfig.tcp.services) {
              mainConfig.tcp.services = {
                ...mainConfig.tcp.services,
                ...agentConfig.tcp.services,
              };
            }
          }
        }
      }

      // Save the merged configuration back to the main file
      await this.saveConfig(this.mainDynamicConfigPath, mainConfig);
      logger.info(`Merged agent configurations into main dynamic config`);

      return true;
    } catch (err) {
      logger.error(`Failed to merge agent configs: ${err.message}`);
      return false;
    }
  }

  async getMainConfig() {
    try {
      const content = await fs.readFile(this.mainDynamicConfigPath, "utf8");
      return (
        yaml.parse(content) || {
          http: { routers: {}, services: {}, middlewares: {} },
        }
      );
    } catch (err) {
      if (err.code === "ENOENT") {
        return { http: { routers: {}, services: {}, middlewares: {} } };
      }
      throw err;
    }
  }

  async saveConfig(configPath, config) {
    const yamlStr = yaml.stringify(config, {
      indent: 2,
      aliasDuplicateObjects: false,
    });

    await fs.writeFile(configPath, yamlStr, "utf8");
    logger.info(`Config saved to ${configPath}`);
    return true;
  }

  async updateTraefikConfig() {
    // Update the Traefik static config to include the agents directory
    const traefikConfigPath =
      process.env.TRAEFIK_CONFIG_PATH || "/config/traefik.yml";

    try {
      let traefikConfig;
      try {
        const content = await fs.readFile(traefikConfigPath, "utf8");
        traefikConfig = yaml.parse(content);
      } catch (err) {
        logger.error("Could not read traefik config:", err);
        return false;
      }

      // Update providers configuration to watch agents directory
      if (!traefikConfig.providers) {
        traefikConfig.providers = {};
      }

      if (!traefikConfig.providers.file) {
        traefikConfig.providers.file = {};
      }

      // Keep the main dynamic config
      if (!traefikConfig.providers.file.filename) {
        traefikConfig.providers.file.filename = "/config/dynamic.yml";
      }

      // Add directory provider for agents
      traefikConfig.providers.directory = {
        directory: "/config/agents",
        watch: true,
      };

      await this.saveConfig(traefikConfigPath, traefikConfig);
      return true;
    } catch (err) {
      logger.error("Failed to update Traefik config:", err);
      return false;
    }
  }

  async listAgents() {
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
