/**
 * Proxy Service
 *
 * A service focused solely on proxying traffic to agent VPSs using subdomains.
 * This consolidates and streamlines routing functionality from the previous system.
 */

const logger = require("../../utils/logger").getLogger("proxyService");
const { AppError } = require("../../utils/errorHandler");
const { withRetry } = require("../../utils/retryHandler");
const HAProxyService = require("./haproxyService");

class ProxyService {
  constructor() {
    this.initialized = false;
    this.haproxyService = new HAProxyService();
    this.appDomain = process.env.APP_DOMAIN || "apps.cloudlunacy.uk";
    this.mongoDomain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
  }

  /**
   * Initialize the proxy service
   */
  async initialize() {
    if (this.initialized) {
      return true;
    }

    logger.info("Initializing proxy service");

    try {
      // Initialize HAProxy service
      const haproxyInitialized = await this.haproxyService.initialize();
      if (!haproxyInitialized) {
        logger.error("Failed to initialize HAProxy service");
        return false;
      }

      this.initialized = true;
      logger.info("Proxy service initialized successfully");
      return true;
    } catch (err) {
      logger.error(`Failed to initialize proxy service: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return false;
    }
  }

  /**
   * Add HTTP route for an agent's application
   * @param {string} agentId - Agent ID
   * @param {string} subdomain - Subdomain to use
   * @param {string} targetUrl - Target URL to proxy to
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Result
   */
  async addHttpRoute(agentId, subdomain, targetUrl, options = {}) {
    if (!this.initialized) {
      await this.initialize();
    }

    // Input validation
    if (!agentId) {
      throw new AppError("Agent ID is required", 400);
    }

    if (!subdomain) {
      throw new AppError("Subdomain is required", 400);
    }

    if (!targetUrl) {
      throw new AppError("Target URL is required", 400);
    }

    logger.info(
      `Adding HTTP route for ${subdomain}.${this.appDomain} to ${targetUrl}`
    );

    // Add HTTP route using HAProxy service
    return this.haproxyService.addHttpRoute(
      agentId,
      subdomain,
      targetUrl,
      options
    );
  }

  /**
   * Add a MongoDB route for an agent
   * @param {string} agentId - Agent ID
   * @param {string} targetHost - Target host
   * @param {number} targetPort - Target port (default: 27017)
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Result
   */
  async addMongoDBRoute(agentId, targetHost, targetPort = 27017, options = {}) {
    if (!this.initialized) {
      await this.initialize();
    }

    // Input validation
    if (!agentId) {
      throw new AppError("Agent ID is required", 400);
    }

    if (!targetHost) {
      throw new AppError("Target host is required", 400);
    }

    logger.info(
      `Adding MongoDB route for ${agentId}.${this.mongoDomain} to ${targetHost}:${targetPort}`
    );

    // Add MongoDB route using HAProxy service
    return this.haproxyService.addMongoDBRoute(
      agentId,
      targetHost,
      targetPort,
      options
    );
  }

  /**
   * Remove a route (HTTP or MongoDB)
   * @param {string} agentId - Agent ID
   * @param {string} subdomain - Subdomain (for HTTP routes)
   * @param {string} type - Route type ("http" or "mongodb")
   * @returns {Promise<Object>} Result
   */
  async removeRoute(agentId, subdomain, type = "http") {
    if (!this.initialized) {
      await this.initialize();
    }

    // Input validation
    if (!agentId) {
      throw new AppError("Agent ID is required", 400);
    }

    if (type === "http" && !subdomain) {
      throw new AppError("Subdomain is required for HTTP routes", 400);
    }

    logger.info(`Removing ${type} route for agent ${agentId}`);

    // Remove route using HAProxy service
    return this.haproxyService.removeRoute(agentId, subdomain, type);
  }

  /**
   * Get all routes for a specific agent
   * @param {string} agentId - Agent ID
   * @returns {Promise<Object>} Routes information
   */
  async getAgentRoutes(agentId) {
    if (!this.initialized) {
      await this.initialize();
    }

    return this.haproxyService.getAgentRoutes(agentId);
  }

  /**
   * Get all routes
   * @returns {Promise<Object>} All routes
   */
  async getAllRoutes() {
    if (!this.initialized) {
      await this.initialize();
    }

    return this.haproxyService.getAllRoutes();
  }

  /**
   * Check HAProxy health
   * @returns {Promise<Object>} Health status
   */
  async checkHealth() {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      // Simple health check: Check if HAProxy is running
      const isHealthy = await withRetry(
        async () => {
          try {
            // Using HAProxy service to check if the port is listening
            const mongoPortAvailable =
              await this.haproxyService.checkMongoDBPort();
            return { healthy: mongoPortAvailable };
          } catch (err) {
            return { healthy: false, error: err.message };
          }
        },
        { maxRetries: 2, initialDelay: 500 }
      );

      return {
        success: true,
        status: isHealthy.healthy ? "healthy" : "unhealthy",
        ...isHealthy,
      };
    } catch (err) {
      logger.error(`Health check failed: ${err.message}`);
      return {
        success: false,
        status: "unhealthy",
        error: err.message,
      };
    }
  }

  /**
   * Repair proxy configuration if needed
   * @returns {Promise<Object>} Repair result
   */
  async repair() {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      // Check if MongoDB port is available
      const mongoPortAvailable = await this.haproxyService.checkMongoDBPort();
      if (!mongoPortAvailable) {
        // Try to fix MongoDB port configuration
        await this.haproxyService.ensureMongoDBPort();
      }

      return {
        success: true,
        message: "Proxy configuration repaired successfully",
      };
    } catch (err) {
      logger.error(`Repair failed: ${err.message}`);
      return {
        success: false,
        error: err.message,
      };
    }
  }
}

module.exports = ProxyService;
