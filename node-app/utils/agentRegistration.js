// utils/agentRegistration.js

const axios = require("axios");
const logger = require("./logger").getLogger("agentRegistration");
const configManager = require("./configManager");
const connectivityTester = require("./connectivityTester");
const { promisify } = require("util");
const exec = promisify(require("child_process").exec);

class AgentRegistrationManager {
  constructor() {
    // Configuration
    this.mongoDomain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
    this.frontApiUrl = process.env.FRONT_API_URL || "http://localhost:3005";
    this.jwtSecret = process.env.JWT_SECRET;

    if (!this.jwtSecret) {
      logger.warn(
        "JWT_SECRET environment variable is not set. Agent registration will not work properly."
      );
    }
  }

  /**
   * Register a new agent with enhanced validation
   * @param {string} agentId - Agent ID
   * @param {string} targetIp - Agent IP address
   * @returns {Promise<object>} - Registration result
   */
  async registerAgent(agentId, targetIp) {
    logger.info(`Registering agent ${agentId} with IP ${targetIp}`);

    try {
      // Step 1: Validate inputs
      if (!this.validateInputs(agentId, targetIp)) {
        throw new Error("Invalid agent ID or target IP");
      }

      // Step 2: Generate JWT for agent authentication
      const token = this.generateAgentToken(agentId);

      // Step 3: Configure MongoDB routing
      const mongoResult = await this.setupMongoDBRouting(agentId, targetIp);

      // Step 4: Test connectivity
      const connectionTest = await this.testAgentConnectivity(
        agentId,
        targetIp
      );

      return {
        success: true,
        agentId,
        token,
        mongodbUrl: `${agentId}.${this.mongoDomain}`,
        targetIp,
        mongoDbRouting: mongoResult,
        connectivityTest: connectionTest,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      logger.error(`Agent registration failed: ${err.message}`);

      return {
        success: false,
        agentId,
        error: err.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Validate agent ID and target IP
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
      logger.error(`Invalid agent ID: ${agentId}`);
    }

    if (!validIp) {
      logger.error(`Invalid IP address: ${targetIp}`);
    }

    return validAgentId && validIp;
  }

  /**
   * Generate JWT token for agent authentication
   */
  generateAgentToken(agentId) {
    if (!this.jwtSecret) {
      logger.error("JWT_SECRET is not set, cannot generate token");
      throw new Error("JWT_SECRET is not configured");
    }

    const jwt = require("jsonwebtoken");

    const payload = {
      agentId,
      role: "agent",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 30 days
    };

    return jwt.sign(payload, this.jwtSecret);
  }

  /**
   * Setup MongoDB routing for the agent
   */
  async setupMongoDBRouting(agentId, targetIp) {
    logger.info(
      `Setting up MongoDB routing for agent ${agentId} at ${targetIp}`
    );

    try {
      // Initialize config manager
      await configManager.initialize();

      // Get agent config
      const config = await configManager.getAgentConfig(agentId);

      // Make sure TCP section exists
      if (!config.tcp) {
        config.tcp = { routers: {}, services: {} };
      }

      // Define router and service names
      const routerName = `mongodb-${agentId}`;
      const serviceName = `mongodb-${agentId}-service`;

      // Set up the router
      config.tcp.routers[routerName] = {
        rule: `HostSNI(\`${agentId}.${this.mongoDomain}\`)`,
        entryPoints: ["mongodb"],
        service: serviceName,
        tls: {
          passthrough: true,
        },
      };

      // Set up the service
      config.tcp.services[serviceName] = {
        loadBalancer: {
          servers: [{ address: `${targetIp}:27017` }],
        },
      };

      // Save the configuration
      await configManager.saveAgentConfig(agentId, config);

      // Restart Traefik to apply changes
      await this.restartTraefik();

      logger.info(`MongoDB routing setup complete for agent ${agentId}`);

      return {
        success: true,
        routerName,
        serviceName,
      };
    } catch (err) {
      logger.error(`Failed to set up MongoDB routing: ${err.message}`);
      throw err;
    }
  }

  /**
   * Restart Traefik to apply configuration changes
   */
  async restartTraefik() {
    try {
      logger.info("Restarting Traefik to apply configuration changes");

      await exec("docker restart traefik");

      // Wait for Traefik to restart
      logger.info("Waiting for Traefik to restart...");
      await new Promise((resolve) => setTimeout(resolve, 5000));

      logger.info("Traefik restarted successfully");
      return true;
    } catch (err) {
      logger.error(`Failed to restart Traefik: ${err.message}`);
      throw err;
    }
  }

  /**
   * Test connectivity to the agent
   */
  async testAgentConnectivity(agentId, targetIp) {
    logger.info(`Testing connectivity to agent ${agentId} at ${targetIp}`);

    try {
      // Wait a moment for DNS to propagate
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Test direct connection to agent
      const directResult = await connectivityTester.testConnection(targetIp);

      // Test connection through domain
      const domainUrl = `${agentId}.${this.mongoDomain}`;
      const domainResult = await connectivityTester.testConnection(domainUrl);

      // Test DNS resolution
      const dnsResult = await connectivityTester.checkDnsResolution(domainUrl);

      logger.info(`Connectivity test results for agent ${agentId}:`, {
        directConnection: directResult,
        domainConnection: domainResult,
        dnsResolution: dnsResult.success,
      });

      return {
        directConnection: directResult,
        domainConnection: domainResult,
        dnsResolution: dnsResult,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      logger.error(`Connectivity test failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * List all registered agents
   */
  async listAgents() {
    try {
      await configManager.initialize();
      const agents = await configManager.listAgents();

      return {
        success: true,
        agents,
        count: agents.length,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      logger.error(`Failed to list agents: ${err.message}`);

      return {
        success: false,
        error: err.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Deregister an agent
   */
  async deregisterAgent(agentId) {
    logger.info(`Deregistering agent ${agentId}`);

    try {
      // Initialize config manager
      await configManager.initialize();

      // Remove agent config
      const removed = await configManager.removeAgentConfig(agentId);

      if (!removed) {
        throw new Error(`Failed to remove agent ${agentId}`);
      }

      // Restart Traefik to apply changes
      await this.restartTraefik();

      logger.info(`Agent ${agentId} deregistered successfully`);

      return {
        success: true,
        agentId,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      logger.error(`Failed to deregister agent ${agentId}: ${err.message}`);

      return {
        success: false,
        agentId,
        error: err.message,
        timestamp: new Date().toISOString(),
      };
    }
  }
}

module.exports = new AgentRegistrationManager();
