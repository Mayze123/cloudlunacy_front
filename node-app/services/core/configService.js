/**
 * Configuration Service
 *
 * Single source of truth for all configuration management.
 * Handles loading, saving, and validating configuration files.
 */

const fs = require("fs").promises;
const path = require("path");
const logger = require("../../utils/logger").getLogger("configService");
const pathManager = require("../../utils/pathManager");

class ConfigService {
  constructor() {
    // Configuration paths
    this.paths = {
      base: process.env.CONFIG_BASE_PATH || "/app/config",
      agents: process.env.AGENTS_CONFIG_DIR || "/app/config/agents",
      consul: process.env.CONSUL_CONFIG_PATH || "/app/config/consul",
      docker: process.env.DOCKER_COMPOSE_PATH || "/app/docker-compose.yml",
    };

    // Configuration domains
    this.domains = {
      mongo: process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk",
      app: process.env.APP_DOMAIN || "apps.cloudlunacy.uk",
    };

    // Loaded configurations
    this.configs = {
      agents: new Map(),
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
      this.paths.consul = path.join(this.paths.base, "consul");

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
    this.paths.consul = "/app/config/consul";

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
   * Get configuration for a specific agent
   * @param {string} agentId - Agent ID
   * @returns {Promise<Object>} Agent configuration
   */
  async getAgentConfig(agentId) {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // Construct the agent config file path
      const agentConfigPath = path.join(this.paths.agents, `${agentId}.yml`);

      // Check if the agent config file exists
      let configExists = true;
      try {
        await fs.access(agentConfigPath);
      } catch (_err) {
        configExists = false;
        logger.warn(
          `Agent config file not found for agent ${agentId}, will create one`
        );

        // Create a basic agent configuration file
        const basicConfig = `# Configuration for agent ${agentId}
agent:
  id: ${agentId}
  registered: true
  registeredAt: ${new Date().toISOString()}
`;
        try {
          await fs.writeFile(agentConfigPath, basicConfig, "utf8");
          logger.info(`Created basic configuration file for agent ${agentId}`);
          configExists = true;
        } catch (writeErr) {
          logger.error(
            `Failed to create agent config file: ${writeErr.message}`
          );
        }
      }

      if (!configExists) {
        return {
          success: false,
          message: `Failed to create configuration for agent ${agentId}`,
        };
      }

      // Check routes for this agent through the proxy service
      let mongoRouteExists = false;
      let redisRouteExists = false;

      try {
        // Use the proxy service if available
        const coreServices = require("../core");
        if (
          coreServices &&
          coreServices.proxyService &&
          coreServices.proxyService.initialized
        ) {
          const routeInfo = await coreServices.proxyService.getAgentRoutes(
            agentId
          );

          // Check if routes is an array
          if (routeInfo && Array.isArray(routeInfo.routes)) {
            mongoRouteExists = routeInfo.routes.some(
              (route) => route.type === "mongodb"
            );
            redisRouteExists = routeInfo.routes.some(
              (route) => route.type === "redis"
            );
          }
          // If routes is not an array, check routesByType (backwards compatibility)
          else if (routeInfo && routeInfo.routesByType) {
            mongoRouteExists =
              routeInfo.routesByType.mongodb &&
              routeInfo.routesByType.mongodb.length > 0;
            redisRouteExists = false; // Redis is not currently supported in the new structure
          }
        }
      } catch (proxyErr) {
        logger.warn(
          `Failed to check proxy routes for agent ${agentId}: ${proxyErr.message}`
        );
      }

      // Get certificates using the CertificateService's single source of truth
      let certificates = null;
      try {
        // Check if we have access to the certificate service
        const coreServices = require("../core");
        if (coreServices && coreServices.certificateService) {
          // Get the agent's IP address from agent service if available
          let agentIp = null;
          if (coreServices.agentService) {
            try {
              // Check if agent service has a record for this agent
              const agentData = coreServices.agentService.agents.get(agentId);
              if (agentData && agentData.targetIp) {
                agentIp = agentData.targetIp;
                logger.info(`Using stored IP ${agentIp} for agent ${agentId}`);
              }
            } catch (ipErr) {
              logger.warn(
                `Failed to get agent IP for ${agentId}: ${ipErr.message}`
              );
            }
          }

          // If no IP found, use a fallback that works with the agent
          if (!agentIp) {
            agentIp = "0.0.0.0"; // This is better than 127.0.0.1 for certificates
            logger.warn(
              `Using fallback IP ${agentIp} for agent ${agentId} certificates`
            );
          }

          // First, try to get existing certificates from the single source of truth
          try {
            logger.info(`Retrieving certificates for agent ${agentId}`);
            const existingCerts =
              await coreServices.certificateService.getAgentCertificates(
                agentId
              );

            if (existingCerts && !existingCerts.error) {
              certificates = {
                caCert: existingCerts.caCert,
                serverCert: existingCerts.serverCert,
                serverKey: existingCerts.serverKey,
                source: existingCerts.usedFallback ? "fallback" : "primary",
              };
              logger.info(
                `Certificates retrieved for agent ${agentId} from ${certificates.source} location`
              );
            } else {
              // No existing certificates, generate new ones
              logger.info(
                `No existing certificates found, generating new ones for agent ${agentId}`
              );
              const certResult =
                await coreServices.certificateService.generateAgentCertificate(
                  agentId,
                  agentIp
                );

              if (certResult && certResult.success) {
                certificates = {
                  caCert: certResult.caCert,
                  serverCert: certResult.serverCert,
                  serverKey: certResult.serverKey,
                  source: "generated",
                };
                logger.info(`Certificates generated for agent ${agentId}`);
              } else {
                logger.warn(
                  `Failed to generate certificates for agent ${agentId}: ${
                    certResult ? certResult.error : "Unknown error"
                  }`
                );
              }
            }
          } catch (retrieveErr) {
            logger.warn(
              `Failed to retrieve certificates, generating new ones: ${retrieveErr.message}`
            );

            // If retrieval fails, fall back to generate new certificates
            const certResult =
              await coreServices.certificateService.generateAgentCertificate(
                agentId,
                agentIp
              );

            if (certResult && certResult.success) {
              certificates = {
                caCert: certResult.caCert,
                serverCert: certResult.serverCert,
                serverKey: certResult.serverKey,
                source: "generated-fallback",
              };
              logger.info(
                `Certificates generated as fallback for agent ${agentId}`
              );
            }
          }
        } else {
          logger.warn(
            `Certificate service not available, skipping certificate generation for agent ${agentId}`
          );
        }
      } catch (certErr) {
        logger.error(
          `Error handling certificates for agent ${agentId}: ${certErr.message}`
        );
      }

      // Return agent configuration summary with certificates if available
      const result = {
        success: true,
        agentId,
        routing: {
          mongodb: mongoRouteExists,
          redis: redisRouteExists,
        },
        domains: {
          mongodb: mongoRouteExists ? `${agentId}.${this.domains.mongo}` : null,
          app: `*.${agentId}.${this.domains.app}`,
        },
      };

      // Add certificates if available
      if (certificates) {
        result.certificates = certificates;
      }

      return result;
    } catch (err) {
      logger.error(
        `Failed to get agent config for ${agentId}: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
        }
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
   * Repair the configuration
   */
  async repair() {
    logger.info("Repairing configuration");

    // Reset state
    this.initialized = false;
    this.configs.agents.clear();

    // Re-initialize
    await this.initialize();

    // Ensure agent configurations are valid
    const agents = await this.listAgents();
    for (const agentId of agents) {
      try {
        await this.getAgentConfig(agentId);
      } catch (err) {
        logger.warn(`Failed to repair agent ${agentId} config: ${err.message}`);
      }
    }

    logger.info("Configuration repair completed");
    return true;
  }
}

module.exports = ConfigService;
