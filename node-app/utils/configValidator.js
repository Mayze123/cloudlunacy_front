// utils/configValidator.js

const fs = require("fs").promises;
const path = require("path");
const yaml = require("yaml");
const logger = require("./logger").getLogger("configValidator");
const { execSync } = require("child_process");

class ConfigValidator {
  constructor() {
    // Determine whether we're running in Docker or not
    this.inDocker = this.checkIfRunningInDocker();

    // Configure paths based on environment
    if (this.inDocker) {
      logger.info("Running in Docker environment, adjusting paths");
      // Configuration paths inside Docker
      this.configPaths = {
        dynamic: process.env.DYNAMIC_CONFIG_PATH || "/app/config/dynamic.yml",
        agents: process.env.AGENTS_CONFIG_DIR || "/app/config/agents",
        dockerCompose:
          process.env.DOCKER_COMPOSE_PATH || "/app/docker-compose.yml",
      };
    } else {
      // Configuration paths on host
      this.configPaths = {
        dynamic:
          process.env.DYNAMIC_CONFIG_PATH ||
          "/opt/cloudlunacy_front/config/dynamic.yml",
        agents:
          process.env.AGENTS_CONFIG_DIR ||
          "/opt/cloudlunacy_front/config/agents",
        dockerCompose:
          process.env.DOCKER_COMPOSE_PATH ||
          "/opt/cloudlunacy_front/docker-compose.yml",
      };
    }

    // Try to find docker-compose.yml with fallbacks
    this.findDockerComposeFile();

    // Log the configuration paths
    logger.info(`Dynamic config path: ${this.configPaths.dynamic}`);
    logger.info(`Agents config dir: ${this.configPaths.agents}`);
    logger.info(`Docker compose path: ${this.configPaths.dockerCompose}`);

    // MongoDB domain
    this.mongoDomain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";

    // Define expected configuration structure
    this.templateConfig = {
      http: {
        routers: {},
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

  /**
   * Check if running in Docker container
   */
  checkIfRunningInDocker() {
    try {
      return (
        fs.existsSync("/.dockerenv") ||
        (fs.existsSync("/proc/1/cgroup") &&
          fs.readFileSync("/proc/1/cgroup", "utf8").includes("docker"))
      );
    } catch (err) {
      logger.warn(`Error checking if running in Docker: ${err.message}`);
      return false;
    }
  }

  /**
   * Try to find the docker-compose.yml file with fallbacks
   */
  findDockerComposeFile() {
    const possiblePaths = [
      this.configPaths.dockerCompose,
      "/app/docker-compose.yml",
      "/opt/cloudlunacy_front/docker-compose.yml",
      "./docker-compose.yml",
      "../docker-compose.yml",
      path.join(process.cwd(), "docker-compose.yml"),
      path.join(process.cwd(), "..", "docker-compose.yml"),
    ];

    for (const filePath of possiblePaths) {
      try {
        // Use sync method to check file existence immediately
        if (require("fs").existsSync(filePath)) {
          logger.info(`Found docker-compose.yml at ${filePath}`);
          this.configPaths.dockerCompose = filePath;
          return;
        }
      } catch (err) {
        // Continue to next path
      }
    }

    logger.warn(
      "Could not find docker-compose.yml in any of the usual locations"
    );
  }

  /**
   * Run full configuration validation
   */
  async validateAll() {
    logger.info("Starting full configuration validation");

    const results = {
      dynamic: await this.validateDynamicConfig(),
      dockerCompose: await this.validateDockerCompose(),
      agents: await this.validateAgentConfigs(),
    };

    // Calculate overall status
    const status = Object.values(results).every((result) => result.valid);

    return {
      valid: status,
      results,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Read and parse YAML file safely
   */
  async readYamlFile(filePath) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      try {
        return {
          success: true,
          data: yaml.parse(content),
          original: content,
        };
      } catch (parseErr) {
        logger.error(`Error parsing YAML file ${filePath}:`, {
          error: parseErr.message,
        });
        return {
          success: false,
          error: parseErr.message,
          original: content,
        };
      }
    } catch (readErr) {
      logger.error(`Error reading file ${filePath}:`, {
        error: readErr.message,
      });
      return {
        success: false,
        error: readErr.message,
      };
    }
  }

  /**
   * Write YAML file safely
   */
  async writeYamlFile(filePath, data) {
    try {
      // Format YAML with proper indentation
      const yamlStr = yaml.stringify(data, {
        indent: 2,
        aliasDuplicateObjects: false,
      });

      // Make backup first
      try {
        const backupPath = `${filePath}.backup.${Date.now()}`;
        await fs.copyFile(filePath, backupPath);
        logger.debug(`Created backup at ${backupPath}`);
      } catch (backupErr) {
        // If file doesn't exist yet, no need for backup
        if (backupErr.code !== "ENOENT") {
          logger.warn(`Failed to create backup: ${backupErr.message}`);
        }
      }

      // Write new file
      await fs.writeFile(filePath, yamlStr, "utf8");
      logger.info(`Successfully wrote configuration to ${filePath}`);
      return true;
    } catch (err) {
      logger.error(`Failed to write to ${filePath}:`, { error: err.message });
      return false;
    }
  }

  /**
   * Validate and fix main dynamic configuration
   */
  async validateDynamicConfig() {
    logger.info(
      `Validating dynamic configuration at ${this.configPaths.dynamic}`
    );

    // Read current config
    const result = await this.readYamlFile(this.configPaths.dynamic);

    if (!result.success) {
      logger.warn(
        `Dynamic configuration file not found or invalid, creating new one`
      );
      const created = await this.writeYamlFile(
        this.configPaths.dynamic,
        this.templateConfig
      );
      return {
        valid: created,
        fixes: ["created_new_config"],
        message: created
          ? "Created new configuration file"
          : "Failed to create configuration file",
      };
    }

    const config = result.data;
    let needsFix = false;
    const fixes = [];

    // Validate HTTP section
    if (!config.http) {
      config.http = this.templateConfig.http;
      needsFix = true;
      fixes.push("added_http_section");
    } else {
      // Ensure all subsections exist
      if (!config.http.routers) {
        config.http.routers = {};
        needsFix = true;
        fixes.push("added_http_routers");
      }

      if (!config.http.services) {
        config.http.services = {};
        needsFix = true;
        fixes.push("added_http_services");
      }

      if (!config.http.middlewares) {
        config.http.middlewares = this.templateConfig.http.middlewares;
        needsFix = true;
        fixes.push("added_http_middlewares");
      } else {
        // Ensure critical middlewares exist
        if (!config.http.middlewares["web-to-websecure"]) {
          config.http.middlewares["web-to-websecure"] =
            this.templateConfig.http.middlewares["web-to-websecure"];
          needsFix = true;
          fixes.push("added_web_to_websecure_middleware");
        }
      }
    }

    // Validate TCP section
    if (!config.tcp) {
      config.tcp = this.templateConfig.tcp;
      needsFix = true;
      fixes.push("added_tcp_section");
    } else {
      // Ensure all subsections exist
      if (!config.tcp.routers) {
        config.tcp.routers = this.templateConfig.tcp.routers;
        needsFix = true;
        fixes.push("added_tcp_routers");
      } else if (!config.tcp.routers["mongodb-catchall"]) {
        config.tcp.routers["mongodb-catchall"] =
          this.templateConfig.tcp.routers["mongodb-catchall"];
        needsFix = true;
        fixes.push("added_mongodb_catchall_router");
      }

      if (!config.tcp.services) {
        config.tcp.services = this.templateConfig.tcp.services;
        needsFix = true;
        fixes.push("added_tcp_services");
      } else if (!config.tcp.services["mongodb-catchall-service"]) {
        config.tcp.services["mongodb-catchall-service"] =
          this.templateConfig.tcp.services["mongodb-catchall-service"];
        needsFix = true;
        fixes.push("added_mongodb_catchall_service");
      }
    }

    // Apply fixes if needed
    if (needsFix) {
      logger.info(`Fixing dynamic configuration with ${fixes.length} changes`);
      const written = await this.writeYamlFile(
        this.configPaths.dynamic,
        config
      );

      if (written) {
        logger.info("Dynamic configuration fixed successfully");
        return {
          valid: true,
          fixes,
          message: "Configuration was invalid but has been fixed",
        };
      } else {
        logger.error("Failed to write fixed dynamic configuration");
        return {
          valid: false,
          fixes,
          message: "Failed to write fixed configuration",
        };
      }
    }

    logger.info("Dynamic configuration is valid");
    return {
      valid: true,
      fixes: [],
      message: "Configuration is valid",
    };
  }

  /**
   * Validate and fix docker-compose.yml to ensure MongoDB port is exposed
   */
  async validateDockerCompose() {
    logger.info(
      `Validating docker-compose.yml at ${this.configPaths.dockerCompose}`
    );

    try {
      // Check if file exists
      try {
        await fs.access(this.configPaths.dockerCompose);
      } catch (accessErr) {
        logger.warn(
          `Docker compose file not found at ${this.configPaths.dockerCompose}`
        );

        // When running in container, we don't need to validate docker-compose.yml
        if (this.inDocker) {
          logger.info(
            "Running in Docker, skipping docker-compose.yml validation"
          );
          return {
            valid: true,
            fixes: [],
            message: "Skipped validation (running in Docker)",
          };
        }

        return {
          valid: false,
          fixes: [],
          message: `Error: ${accessErr.message}`,
        };
      }

      // Read docker-compose.yml
      const content = await fs.readFile(this.configPaths.dockerCompose, "utf8");

      // Check if MongoDB port is defined
      if (
        content.includes('"27017:27017"') ||
        content.includes("'27017:27017'")
      ) {
        logger.info(
          "MongoDB port 27017 is properly defined in docker-compose.yml"
        );
        return {
          valid: true,
          fixes: [],
          message: "MongoDB port is properly configured",
        };
      }

      logger.warn(
        "MongoDB port 27017 is not defined in docker-compose.yml, fixing"
      );

      // Create backup
      const backupPath = `${
        this.configPaths.dockerCompose
      }.backup.${Date.now()}`;
      await fs.writeFile(backupPath, content);

      // Add MongoDB port using different pattern matching strategies
      let updatedContent = content;

      // Try different patterns
      const patterns = [
        {
          regex: /ports:([^\]]*?)(\s+-)(\s+)"8081:8081"/s,
          replacement: 'ports:$1$2$3"8081:8081"$2$3"27017:27017"',
        },
        {
          regex: /(ports:\s*(?:-\s+[^\s]+\s+)+)/s,
          replacement: '$1- "27017:27017"\n      ',
        },
        {
          regex: /(ports:.*?)\n/s,
          replacement: '$1\n      - "27017:27017"\n',
        },
      ];

      // Try each pattern until one works
      for (const pattern of patterns) {
        const testContent = updatedContent.replace(
          pattern.regex,
          pattern.replacement
        );
        if (testContent !== updatedContent) {
          updatedContent = testContent;
          break;
        }
      }

      // Check if any pattern matched
      if (updatedContent === content) {
        logger.error(
          "Could not modify docker-compose.yml - no matching patterns"
        );
        return {
          valid: false,
          fixes: [],
          message: "Failed to add MongoDB port to docker-compose.yml",
        };
      }

      // Write updated content
      await fs.writeFile(this.configPaths.dockerCompose, updatedContent);
      logger.info("Added MongoDB port 27017 to docker-compose.yml");

      return {
        valid: true,
        fixes: ["added_mongodb_port"],
        message: "Added MongoDB port to docker-compose.yml",
      };
    } catch (err) {
      logger.error(`Error validating docker-compose.yml: ${err.message}`);
      return {
        valid: false,
        fixes: [],
        message: `Error: ${err.message}`,
      };
    }
  }

  /**
   * Validate agent configurations to ensure proper MongoDB routing
   */
  async validateAgentConfigs() {
    logger.info(
      `Validating agent configurations in ${this.configPaths.agents}`
    );

    try {
      // Check if agents directory exists
      try {
        await fs.access(this.configPaths.agents);
      } catch (err) {
        if (err.code === "ENOENT") {
          logger.info("Agents directory does not exist, creating it");
          await fs.mkdir(this.configPaths.agents, { recursive: true });
        } else {
          throw err;
        }
      }

      // List agent configuration files
      const files = await fs.readdir(this.configPaths.agents);
      const agentFiles = files.filter(
        (file) => file.endsWith(".yml") && file !== "default.yml"
      );
      logger.info(`Found ${agentFiles.length} agent configuration files`);

      if (agentFiles.length === 0) {
        logger.info("No agent configurations found, nothing to validate");
        return {
          valid: true,
          fixes: [],
          message: "No agent configurations to validate",
        };
      }

      // Validate each agent config
      const results = [];

      for (const file of agentFiles) {
        const agentId = file.replace(".yml", "");
        logger.info(`Validating configuration for agent ${agentId}`);

        const filePath = path.join(this.configPaths.agents, file);
        const result = await this.readYamlFile(filePath);

        if (!result.success) {
          logger.error(`Failed to read agent config for ${agentId}`);
          results.push({
            agentId,
            valid: false,
            fixes: [],
            message: `Failed to read configuration: ${result.error}`,
          });
          continue;
        }

        const config = result.data;
        let needsFix = false;
        const fixes = [];

        // Ensure TCP section exists
        if (!config.tcp) {
          config.tcp = { routers: {}, services: {} };
          needsFix = true;
          fixes.push("added_tcp_section");
        }

        // Check MongoDB router configurations
        const routerName = `mongodb-${agentId}`;
        const serviceName = `mongodb-${agentId}-service`;

        // Fix incorrect wildcard routes
        if (config.tcp.routers && config.tcp.routers[routerName]) {
          const router = config.tcp.routers[routerName];

          // Check for wildcard rules that could cause routing issues
          if (router.rule && router.rule.includes("HostSNI(`*`)")) {
            router.rule = `HostSNI(\`${agentId}.${this.mongoDomain}\`)`;
            needsFix = true;
            fixes.push("removed_wildcard_hostsni");
          }
        } else if (config.tcp.routers) {
          // Create router if missing
          config.tcp.routers[routerName] = {
            rule: `HostSNI(\`${agentId}.${this.mongoDomain}\`)`,
            entryPoints: ["mongodb"],
            service: serviceName,
            tls: {
              passthrough: true,
            },
          };
          needsFix = true;
          fixes.push("added_mongodb_router");
        }

        // Apply fixes if needed
        if (needsFix) {
          logger.info(
            `Fixing configuration for agent ${agentId} with ${fixes.length} changes`
          );
          const written = await this.writeYamlFile(filePath, config);

          if (written) {
            logger.info(
              `Configuration for agent ${agentId} fixed successfully`
            );
            results.push({
              agentId,
              valid: true,
              fixes,
              message: "Configuration was invalid but has been fixed",
            });
          } else {
            logger.error(
              `Failed to write fixed configuration for agent ${agentId}`
            );
            results.push({
              agentId,
              valid: false,
              fixes,
              message: "Failed to write fixed configuration",
            });
          }
        } else {
          logger.info(`Configuration for agent ${agentId} is valid`);
          results.push({
            agentId,
            valid: true,
            fixes: [],
            message: "Configuration is valid",
          });
        }
      }

      // Calculate overall status
      const allValid = results.every((result) => result.valid);

      return {
        valid: allValid,
        agents: results,
        message: allValid
          ? "All agent configurations are valid"
          : "Some agent configurations have issues",
      };
    } catch (err) {
      logger.error(`Error validating agent configurations: ${err.message}`);
      return {
        valid: false,
        fixes: [],
        message: `Error: ${err.message}`,
      };
    }
  }

  /**
   * Restart Traefik to apply configuration changes
   */
  async restartTraefik() {
    try {
      logger.info("Restarting Traefik to apply configuration changes");

      // Execute docker restart command
      execSync("docker restart traefik");

      // Wait for Traefik to restart
      logger.info("Waiting for Traefik to restart...");
      await new Promise((resolve) => setTimeout(resolve, 5000));

      logger.info("Traefik restarted successfully");
      return true;
    } catch (err) {
      logger.error(`Failed to restart Traefik: ${err.message}`);
      return false;
    }
  }

  /**
   * Run validation and automatically fix any issues
   */
  async validateAndFix() {
    // Run validation
    const validation = await this.validateAll();

    // Check if any fixes were applied
    const anyFixes = Object.values(validation.results).some(
      (result) => result.fixes && result.fixes.length > 0
    );

    // Restart Traefik if fixes were applied
    if (anyFixes) {
      // Skip restarting Traefik if running in Docker
      if (this.inDocker) {
        logger.info("Running in Docker, skipping Traefik restart");
      } else {
        await this.restartTraefik();
      }
    }

    return {
      ...validation,
      traefikRestarted: anyFixes && !this.inDocker,
    };
  }

  /**
   * Validate MongoDB inputs (subdomain and targetIp)
   * @param {string} subdomain - The subdomain
   * @param {string} targetIp - The target IP address
   * @returns {boolean} - True if inputs are valid
   */
  validateMongoDBInputs(subdomain, targetIp) {
    // Validate subdomain (alphanumeric and hyphens)
    const subdomainRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

    // Validate IP address
    const ipRegex =
      /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

    return subdomainRegex.test(subdomain) && ipRegex.test(targetIp);
  }
}

module.exports = new ConfigValidator();
