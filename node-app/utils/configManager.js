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
      // Ensure the agents directory exists
      await fs.mkdir(this.agentsConfigDir, { recursive: true });

      // Ensure main config exists with correct structure
      let mainConfig;
      try {
        const content = await fs.readFile(this.mainDynamicConfigPath, "utf8");
        mainConfig = yaml.parse(content) || {};
      } catch (err) {
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

        await this.saveConfig(this.mainDynamicConfigPath, mainConfig);
      }

      // Create traefik config to include all agent configs
      await this.updateTraefikConfig();

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

    // No need to update traefik config as it's using dynamic file provider
    // that watches the directory
    return true;
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
    const traefikConfigPath = path.join(this.baseConfigPath, "traefik.yml");

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
