/**
 * Agent Service
 *
 * Handles all agent-related functionality including registration,
 * authentication, and management.
 */

const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const logger = require("../../utils/logger").getLogger("agentService");

class AgentService {
  constructor(configManager, mongodbService) {
    // Store dependencies for other functionality
    this.configManager = configManager;
    this.mongodbService = mongodbService;

    this.initialized = false;
    this.agents = new Map();
    this.jwtSecret =
      process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
    this.tokenExpiration = process.env.TOKEN_EXPIRATION || "30d";

    // Will be loaded from core services during initialize
    this.consulService = null;
  }

  /**
   * Initialize the agent service
   */
  async initialize() {
    logger.info("Initializing agent service");

    try {
      // Get consul service from core services
      const coreServices = require("../core");
      this.consulService = coreServices.consulService;

      // Load existing agents from Consul if available
      if (this.consulService && this.consulService.isInitialized) {
        await this._loadAgentsFromConsul();
      } else {
        logger.warn(
          "Consul service not available, agent data won't be persistent"
        );
      }

      this.initialized = true;
      logger.info("Agent service initialized successfully");
      return true;
    } catch (err) {
      logger.error(`Failed to initialize agent service: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      // Still mark as initialized to avoid blocking the application
      this.initialized = true;
      return true;
    }
  }

  /**
   * Load agents from Consul KV store
   *
   * @private
   */
  async _loadAgentsFromConsul() {
    try {
      logger.info("Loading registered agents from Consul");

      // Clear existing registrations
      this.agents.clear();

      if (!this.consulService || !this.consulService.isInitialized) {
        logger.warn("Consul service not initialized, skipping agent loading");
        return;
      }

      // Get all HTTP routers which represent our agents
      const routersKey = "http/routers";
      const routers = await this.consulService.get(routersKey);

      if (!routers) {
        logger.info("No agents found in Consul");
        return;
      }

      // Process each router to extract agent info
      for (const [name, routerConfig] of Object.entries(routers)) {
        // Skip special/system routers
        if (name === "dashboard" || name === "traefik-healthcheck") {
          continue;
        }

        const serviceName = `${name}-http`;
        const service = await this.consulService.get(
          `http/services/${serviceName}`
        );

        if (
          service &&
          service.loadBalancer &&
          service.loadBalancer.servers &&
          service.loadBalancer.servers.length > 0
        ) {
          const serverUrl = service.loadBalancer.servers[0].url;

          // Extract hostname from URL
          // Format is typically http://hostname:port
          const matches = serverUrl.match(/^http:\/\/([^:]+):(\d+)$/);

          if (matches) {
            const targetIp = matches[1];

            // Add to registry
            this.agents.set(name, {
              targetIp,
              registeredAt: new Date().toISOString(),
              lastSeen: new Date().toISOString(),
            });

            logger.debug(`Loaded agent from Consul: ${name}`);
          }
        }
      }

      logger.info(`Loaded ${this.agents.size} agents from Consul KV store`);
    } catch (err) {
      logger.error(
        `Failed to load registered agents from Consul: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
        }
      );
      // Don't throw, just handle the error gracefully
    }
  }

  /**
   * Register a new agent
   *
   * @param {string} agentId - The agent ID
   * @param {string} targetIp - The target IP address
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Registration result
   */
  async registerAgent(agentId, targetIp, options = {}) {
    logger.info(`Registering agent ${agentId} with IP ${targetIp}`);

    try {
      if (!this.initialized) {
        await this.initialize();
      }

      // Generate a token for this agent
      const token = this.generateAgentToken(agentId);

      // Check if Consul is available
      if (!this.consulService || !this.consulService.isInitialized) {
        logger.error(
          `Cannot register agent ${agentId}, Consul service not available`
        );
        throw new Error("Consul service not available for agent registration");
      }

      // Register in Consul
      const appDomain = process.env.APP_DOMAIN || "cloudlunacy.uk";
      const mongoDomain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";

      // Prepare agent registration with Consul
      const agentConfig = {
        name: agentId,
        subdomain: agentId,
        hostname: targetIp,
        httpPort: options.httpPort || 8080,
        mongoPort: options.mongoPort || 27017,
        secure: options.useTls !== false,
      };

      const consulRegistered = await this.consulService.registerAgent(
        agentConfig
      );

      if (!consulRegistered) {
        logger.error(`Failed to register agent ${agentId} in Consul`);
        throw new Error(
          `Failed to register agent ${agentId} in Consul KV store`
        );
      }

      logger.info(
        `Successfully registered agent ${agentId} in Consul KV store`
      );

      // Save agent registration info in memory cache
      this.agents.set(agentId, {
        targetIp,
        registeredAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      });

      // MongoDB registration is now handled separately when agent explicitly installs MongoDB
      let certificates = null;
      let certificateError = null;

      // Generate certificates if needed
      if (options.generateCertificates !== false) {
        // Get certificate service from core services to ensure we have the latest version
        const coreServices = require("../core");
        const certificateService = coreServices.certificateService;

        if (certificateService) {
          try {
            // Try to initialize the certificate service if needed
            if (!certificateService.initialized) {
              await certificateService.initialize();
            }

            // Attempt certificate generation with retry
            let certResult = null;
            let retryCount = 0;
            const maxRetries = 3;
            let lastError = null;

            do {
              try {
                if (retryCount > 0) {
                  logger.info(
                    `Retry ${retryCount}/${maxRetries} generating certificate for agent ${agentId}`
                  );
                  // Add a small delay before retrying to allow for lock releases
                  await new Promise((resolve) =>
                    setTimeout(resolve, 1000 * retryCount)
                  );
                }

                certResult = await certificateService.generateAgentCertificate(
                  agentId,
                  targetIp
                );

                if (certResult.success) {
                  certificates = {
                    caCert: certResult.caCert,
                    serverKey: certResult.serverKey,
                    serverCert: certResult.serverCert,
                  };
                  logger.info(`Certificates generated for agent ${agentId}`);
                  break; // Exit retry loop on success
                } else if (certResult.transient) {
                  // Transient error means we should retry
                  lastError = certResult.error;
                  logger.warn(
                    `Transient certificate generation issue for agent ${agentId}: ${certResult.error}`
                  );
                } else {
                  // Non-transient error means we should stop retrying
                  certificateError = certResult.error;
                  logger.warn(
                    `Certificate generation warning for agent ${agentId}: ${certResult.error}`
                  );
                  break;
                }
              } catch (certGenErr) {
                lastError = certGenErr.message;
                logger.error(
                  `Certificate generation attempt ${retryCount + 1} failed: ${
                    certGenErr.message
                  }`
                );
              }
            } while (++retryCount < maxRetries && !certificates);

            // If we exhausted retries, record the last error
            if (retryCount >= maxRetries && !certificates) {
              certificateError = `Certificate generation failed after ${maxRetries} attempts. Last error: ${lastError}`;
              logger.error(certificateError);
            }
          } catch (certErr) {
            certificateError = `Certificate service error: ${certErr.message}`;
            logger.error(
              `Certificate generation failed for agent ${agentId}: ${certErr.message}`,
              {
                error: certErr.message,
                stack: certErr.stack,
              }
            );
          }
        } else {
          certificateError = "Certificate service not available";
          logger.warn(`Certificate service not available for agent ${agentId}`);
        }
      }

      // Build response
      const response = {
        success: true,
        agentId,
        token,
        targetIp,
        tlsEnabled: options.useTls !== false,
        consulRegistered: true,
      };

      // Add certificates if available
      if (certificates) {
        response.certificates = certificates;
      } else if (certificateError) {
        // Include certificate error but don't fail the registration
        response.certificateError = certificateError;
        response.tlsEnabled = false; // Can't enable TLS without certificates
      }

      return response;
    } catch (err) {
      logger.error(`Failed to register agent ${agentId}: ${err.message}`, {
        error: err.message,
        stack: err.stack,
        agentId,
        targetIp,
      });
      throw err;
    }
  }

  /**
   * Unregister an agent
   *
   * @param {string} agentId - The agent ID to unregister
   * @returns {Promise<boolean>} Success status
   */
  async unregisterAgent(agentId) {
    logger.info(`Unregistering agent ${agentId}`);

    try {
      if (!this.initialized) {
        await this.initialize();
      }

      // Remove from memory registry
      this.agents.delete(agentId);

      // Check if Consul is available
      if (!this.consulService || !this.consulService.isInitialized) {
        logger.error(
          `Cannot unregister agent ${agentId}, Consul service not available`
        );
        return false;
      }

      // Unregister from Consul
      const consulResult = await this.consulService.unregisterAgent(agentId);

      if (!consulResult) {
        logger.error(`Failed to unregister agent ${agentId} from Consul`);
        return false;
      }

      logger.info(
        `Successfully unregistered agent ${agentId} from Consul KV store`
      );
      return true;
    } catch (err) {
      logger.error(`Failed to unregister agent ${agentId}: ${err.message}`, {
        error: err.message,
        stack: err.stack,
        agentId,
      });
      return false;
    }
  }

  /**
   * Verify an agent token
   */
  verifyAgentToken(token) {
    try {
      if (!this.jwtSecret) {
        throw new Error("JWT_SECRET is not set");
      }

      return jwt.verify(token, this.jwtSecret);
    } catch (err) {
      logger.error(`Failed to verify agent token: ${err.message}`);
      throw err;
    }
  }

  /**
   * Generate a JWT token for agent authentication
   */
  generateAgentToken(agentId, role = "agent") {
    try {
      if (!this.jwtSecret) {
        throw new Error("JWT_SECRET is not set");
      }

      const payload = {
        agentId,
        role,
        iat: Math.floor(Date.now() / 1000),
      };

      return jwt.sign(payload, this.jwtSecret, {
        expiresIn: this.tokenExpiration,
      });
    } catch (err) {
      logger.error(`Failed to generate agent token: ${err.message}`);
      throw err;
    }
  }
}

module.exports = AgentService;
