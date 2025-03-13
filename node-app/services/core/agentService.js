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

class AgentService {
  constructor() {
    this.jwtSecret = process.env.JWT_SECRET;
    if (!this.jwtSecret) {
      logger.warn(
        "JWT_SECRET environment variable is not set. Agent authentication will not work properly."
      );
    }

    this.registeredAgents = new Map();
    this.initialized = false;
  }

  /**
   * Initialize the agent service
   */
  async initialize() {
    if (this.initialized) {
      return true;
    }

    try {
      logger.info("Initializing agent service");

      // Load registered agents from configuration
      const agentIds = await configService.listAgents();

      for (const agentId of agentIds) {
        this.registeredAgents.set(agentId, {
          registeredAt: new Date().toISOString(),
        });
      }

      logger.info(`Loaded ${this.registeredAgents.size} registered agents`);
      this.initialized = true;
      return true;
    } catch (err) {
      logger.error(`Failed to initialize agent service: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      throw err;
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

      // Register MongoDB for the agent
      const mongodbResult = await mongodbService.registerAgent(
        agentId,
        targetIp
      );

      // Save agent registration info
      this.registeredAgents.set(agentId, {
        targetIp,
        registeredAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      });

      return {
        success: true,
        agentId,
        token,
        mongodbUrl: mongodbResult.mongodbUrl,
        targetIp,
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
      this.registeredAgents.clear();

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

  /**
   * Load registered agents from configuration
   */
  async loadRegisteredAgents() {
    try {
      logger.info("Loading registered agents");

      // Clear existing registrations
      this.registeredAgents.clear();

      // Get agent configs
      const agentConfigs = await configService.listAgents();

      for (const agentId of agentConfigs) {
        try {
          // Load agent config
          const agentConfig = await configService.loadAgentConfig(agentId);

          if (agentConfig && agentConfig.registration) {
            // Add to registry
            this.registeredAgents.set(agentId, {
              targetIp: agentConfig.registration.targetIp,
              registeredAt:
                agentConfig.registration.registeredAt ||
                new Date().toISOString(),
              lastSeen:
                agentConfig.registration.lastSeen || new Date().toISOString(),
            });

            logger.debug(`Loaded agent: ${agentId}`);
          }
        } catch (err) {
          logger.warn(`Failed to load agent ${agentId}: ${err.message}`);
        }
      }

      logger.info(`Loaded ${this.registeredAgents.size} agents`);
    } catch (err) {
      logger.error(`Failed to load registered agents: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
    }
  }
}

module.exports = new AgentService();
