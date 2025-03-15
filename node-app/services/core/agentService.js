/**
 * Agent Service
 *
 * Handles all agent-related functionality including registration,
 * authentication, and management.
 */

const jwt = require("jsonwebtoken");
const configService = require("./configService");
const mongodbService = require("./mongodbService");
const logger = require("../../utils/logger").getLogger("agentService");
const crypto = require("crypto");

class AgentService {
  constructor(configManager) {
    this.configManager = configManager;
    this.initialized = false;
    this.agents = new Map();
    this.jwtSecret = process.env.JWT_SECRET || "default-secret-change-me";
    this.tokenExpiration = "7d"; // Default token expiration
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
      return false;
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

      // Check if config manager is initialized
      if (!this.configManager.initialized) {
        await this.configManager.initialize();
      }

      // Get agent configs from main configuration
      const mainConfig = this.configManager.configs.main;

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
    }
  }

  /**
   * Register a new agent
   */
  async registerAgent(agentId, targetIp) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info(`Registering agent ${agentId} with IP ${targetIp}`);

      // Validate inputs
      if (!this.validateInputs(agentId, targetIp)) {
        throw new Error("Invalid agent ID or target IP");
      }

      // Generate JWT token for agent authentication
      const token = this.generateAgentToken(agentId);

      // Register MongoDB for this agent
      const mongoResult = await mongodbService.registerMongoDBAgent(
        agentId,
        targetIp,
        true // Enable TLS by default
      );

      logger.info(
        `MongoDB registered for agent ${agentId} with target IP ${targetIp}`
      );

      // Save agent registration info
      this.agents.set(agentId, {
        targetIp,
        registeredAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      });

      return {
        success: true,
        agentId,
        token,
        targetIp,
        tlsEnabled: true,
        connectionString: mongoResult.connectionString,
      };
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

      return jwt.sign(payload, this.jwtSecret, { expiresIn: "30d" });
    } catch (err) {
      logger.error(`Failed to generate agent token: ${err.message}`);
      throw err;
    }
  }

  /**
   * Validate agent registration inputs
   */
  validateInputs(agentId, targetIp) {
    // Validate agent ID (alphanumeric and hyphens)
    const validAgentId = /^[a-zA-Z0-9-]+$/.test(agentId);

    // Validate IP address
    const validIp =
      /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(
        targetIp
      );

    if (!validAgentId) {
      logger.warn(`Invalid agent ID format: ${agentId}`);
    }

    if (!validIp) {
      logger.warn(`Invalid IP address format: ${targetIp}`);
    }

    return validAgentId && validIp;
  }

  /**
   * Repair agent service
   */
  async repair() {
    try {
      logger.info("Repairing agent service");

      // Reset state
      this.initialized = false;
      this.agents.clear();

      // Re-initialize
      await this.initialize();

      logger.info("Agent service repair completed");
      return true;
    } catch (err) {
      logger.error(`Failed to repair agent service: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return false;
    }
  }
}

module.exports = AgentService;
