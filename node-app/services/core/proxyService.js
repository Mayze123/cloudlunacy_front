/**
 * Proxy Service
 *
 * A service focused solely on proxying traffic to agent VPSs using subdomains.
 * This consolidates and streamlines routing functionality from the previous system.
 */

const logger = require("../../utils/logger").getLogger("proxyService");
const { AppError } = require("../../utils/errorHandler");
const { withRetry } = require("../../utils/retryHandler");
const TraefikService = require("./traefikService");

class ProxyService {
  constructor() {
    this.initialized = false;
    this.traefikService = new TraefikService();
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
      // Initialize Traefik service
      const traefikInitialized = await this.traefikService.initialize();
      if (!traefikInitialized) {
        logger.error("Failed to initialize Traefik service");
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

    // Add HTTP route using Traefik service
    return this.traefikService.addHttpRoute(
      agentId,
      subdomain,
      targetUrl,
      options
    );
  }

  /**
   * Remove a route (HTTP only)
   * @param {string} agentId - Agent ID
   * @param {string} subdomain - Subdomain for HTTP routes
   * @returns {Promise<Object>} Result
   */
  async removeRoute(agentId, subdomain) {
    if (!this.initialized) {
      await this.initialize();
    }

    // Input validation
    if (!agentId) {
      throw new AppError("Agent ID is required", 400);
    }

    if (!subdomain) {
      throw new AppError("Subdomain is required for HTTP routes", 400);
    }

    logger.info(
      `Removing HTTP route for agent ${agentId} subdomain ${subdomain}`
    );

    // Remove route using Traefik service
    return this.traefikService.removeRoute(agentId, subdomain, "http");
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

    return this.traefikService.getAgentRoutes(agentId);
  }

  /**
   * Get all routes
   * @returns {Promise<Object>} All routes
   */
  async getAllRoutes() {
    if (!this.initialized) {
      await this.initialize();
    }

    return this.traefikService.getAllRoutes();
  }

  /**
   * Check Traefik health
   * @returns {Promise<Object>} Health status
   */
  async checkHealth() {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      // Simple health check: Check if Traefik is running
      const isHealthy = await withRetry(
        async () => {
          try {
            const health = await this.traefikService.performHealthCheck();
            return {
              healthy: health.containerRunning && health.pingHealthy,
              details: health,
            };
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

      // Check health and attempt recovery if needed
      const healthStatus = await this.checkHealth();

      if (healthStatus.status === "unhealthy") {
        const recoveryResult = await this.traefikService.recoverService();
        return {
          success: recoveryResult.success,
          message: recoveryResult.message,
          action: recoveryResult.action,
        };
      }

      return {
        success: true,
        message: "Proxy configuration is healthy, no repair needed",
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
