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
    this.configManager = configManager || {};
    this.mongodbService = mongodbService;
    this.initialized = false;
    this.agents = new Map();
    this.jwtSecret =
      process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
    this.tokenExpiration = process.env.TOKEN_EXPIRATION || "30d";
  }

  /**
   * Initialize the agent service
   */
  async initialize() {
    logger.info("Initializing agent service");

    try {
      // Load existing agents from configuration if available
      await this._loadAgents();

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
   * Load agents from configuration
   *
   * @private
   */
  async _loadAgents() {
    try {
      logger.info("Loading registered agents");

      // Clear existing registrations
      this.agents.clear();

      // Check if config manager exists and is initialized
      if (!this.configManager) {
        logger.warn("Config manager is not available, skipping agent loading");
        return;
      }

      // Check if config manager is initialized
      if (typeof this.configManager.initialized === "undefined") {
        logger.warn(
          "Config manager doesn't have an initialized property, skipping initialization check"
        );
      } else if (!this.configManager.initialized) {
        try {
          await this.configManager.initialize();
        } catch (initErr) {
          logger.warn(
            `Failed to initialize config manager: ${initErr.message}`
          );
          return;
        }
      }

      // Get agent configs from main configuration if available
      const mainConfig =
        this.configManager.configs && this.configManager.configs.main;

      // Check if agents section exists in config
      if (mainConfig && mainConfig.agents) {
        for (const [agentId, agentConfig] of Object.entries(
          mainConfig.agents
        )) {
          if (agentConfig && agentConfig.registration) {
            // Add to registry
            this.agents.set(agentId, {
              targetIp: agentConfig.registration.targetIp,
              registeredAt:
                agentConfig.registration.registeredAt ||
                new Date().toISOString(),
              lastSeen:
                agentConfig.registration.lastSeen || new Date().toISOString(),
            });

            logger.debug(`Loaded agent: ${agentId}`);
          }
        }
      }

      logger.info(`Loaded ${this.agents.size} agents`);
    } catch (err) {
      logger.error(`Failed to load registered agents: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
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

      // MongoDB registration is now handled separately
      // This is done when the agent explicitly installs MongoDB
      let certificates = null;

      // Generate certificates if needed
      if (
        options.generateCertificates !== false &&
        this.configManager.certificate
      ) {
        try {
          const certResult =
            await this.configManager.certificate.generateAgentCertificate(
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
          } else {
            logger.warn(
              `Certificate generation warning for agent ${agentId}: ${certResult.error}`
            );
          }
        } catch (certErr) {
          logger.error(
            `Certificate generation failed for agent ${agentId}: ${certErr.message}`,
            {
              error: certErr.message,
              stack: certErr.stack,
            }
          );
          // Continue with agent registration even if certificate generation fails
        }
      }

      // Save agent registration info
      this.agents.set(agentId, {
        targetIp,
        registeredAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      });

      // Build response
      const response = {
        success: true,
        agentId,
        token,
        targetIp,
        tlsEnabled: options.useTls !== false,
      };

      // Add certificates if available
      if (certificates) {
        response.certificates = certificates;
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
