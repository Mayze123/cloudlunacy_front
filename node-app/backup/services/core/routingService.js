/**
 * Routing Service
 *
 * Handles HTTP and TCP route management with proper error handling and retry logic.
 * Uses the new HAProxyConfigManager and retry utilities for better reliability.
 */

const logger = require("../../utils/logger").getLogger("routingService");
const { AppError } = require("../../utils/errorHandler");
const { withRetry } = require("../../utils/retryHandler");
const HAProxyConfigManager = require("./haproxyConfigManager");

class RoutingService {
  constructor() {
    this.initialized = false;
    this.haproxyManager = new HAProxyConfigManager();
    this.routeCache = new Map();
    this.appDomain = process.env.APP_DOMAIN || "apps.cloudlunacy.uk";
    this.mongoDomain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
  }

  /**
   * Initialize the routing service
   */
  async initialize() {
    logger.info("Initializing routing service");

    try {
      // Initialize HAProxy config manager
      await this.haproxyManager.initialize();

      // Load existing routes into cache
      await this._loadRoutesIntoCache();

      this.initialized = true;
      logger.info("Routing service initialized successfully");
      return true;
    } catch (err) {
      logger.error(`Failed to initialize routing service: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return false;
    }
  }

  /**
   * Load existing routes into cache for faster access
   * @private
   */
  async _loadRoutesIntoCache() {
    try {
      logger.info("Loading existing routes into cache");

      // Get HAProxy config
      const config = await this.haproxyManager.loadConfig();

      // Process backends and cache routes
      if (config.backends) {
        for (const backendName of Object.keys(config.backends)) {
          // Extract information from backend name
          // Assumes format: ${agentId}-${subdomain}-backend
          const parts = backendName.split("-");
          if (parts.length >= 3 && parts[parts.length - 1] === "backend") {
            const agentId = parts[0];
            const subdomain = parts.slice(1, parts.length - 1).join("-");

            const backend = config.backends[backendName];
            const server = backend.servers && backend.servers[0];

            if (server) {
              const targetUrl = server.url;

              // Determine if HTTP or TCP route
              const isTcp = backend.mode === "tcp";
              const routeType = isTcp ? "tcp" : "http";

              // Store in cache
              this.routeCache.set(`${routeType}:${agentId}:${subdomain}`, {
                name: backendName,
                domain: isTcp
                  ? `${agentId}.${this.mongoDomain}`
                  : `${subdomain}.${this.appDomain}`,
                targetUrl,
                lastUpdated: new Date().toISOString(),
              });
            }
          }
        }
      }

      logger.info(`Loaded ${this.routeCache.size} routes into cache`);
      return true;
    } catch (err) {
      logger.error(`Failed to load routes into cache: ${err.message}`);
      return false;
    }
  }

  /**
   * Add HTTP route with retry logic and validation
   *
   * @param {string} agentId - The agent ID
   * @param {string} subdomain - The subdomain
   * @param {string} targetUrl - The target URL
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Result
   */
  async addHttpRoute(agentId, subdomain, targetUrl, options = {}) {
    if (!this.initialized) {
      await this.initialize();
    }

    // Validate inputs
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

    return withRetry(
      async () => {
        try {
          // Normalize target URL
          if (
            !targetUrl.startsWith("http://") &&
            !targetUrl.startsWith("https://")
          ) {
            targetUrl = `${options.protocol || "http"}://${targetUrl}`;
          }

          // Generate backend name
          const backendName = `${agentId}-${subdomain}-backend`;

          // Generate domain
          const domain = `${subdomain}.${this.appDomain}`;

          // Create backend options
          const backendOptions = {
            mode: "http",
            options: ["forwardfor"],
            servers: [
              {
                name: `${agentId}-${subdomain}-server`,
                url: targetUrl,
                check: true,
                ssl: options.useTls !== false,
              },
            ],
          };

          // Add backend to HAProxy config
          await this.haproxyManager.addBackend(backendName, backendOptions);

          // Add frontend rule
          const aclName = `host-${agentId}-${subdomain}`;
          const condition = `host_hdr -i ${domain}`;

          await this.haproxyManager.addFrontendRule(
            "https-in",
            backendName,
            condition,
            aclName
          );

          // Apply configuration
          await this.haproxyManager.applyConfig();

          // Update cache
          this.routeCache.set(`http:${agentId}:${subdomain}`, {
            name: backendName,
            domain,
            targetUrl,
            aclName,
            lastUpdated: new Date().toISOString(),
          });

          return {
            success: true,
            agentId,
            subdomain,
            domain,
            targetUrl,
            type: "http",
          };
        } catch (err) {
          // Log and rethrow to allow retry
          logger.error(`Error adding HTTP route: ${err.message}`, {
            error: err.message,
            stack: err.stack,
          });

          throw err;
        }
      },
      {
        maxRetries: 3,
        initialDelay: 1000,
        onRetry: (err, attempt) => {
          logger.warn(`Retry ${attempt} adding HTTP route (${err.message})`);
        },
      }
    );
  }

  /**
   * Add TCP route for MongoDB with retry logic
   *
   * @param {string} agentId - The agent ID
   * @param {string} targetHost - The target host
   * @param {number} targetPort - The target port
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Result
   */
  async addTcpRoute(agentId, targetHost, targetPort, options = {}) {
    if (!this.initialized) {
      await this.initialize();
    }

    // Validate inputs
    if (!agentId) {
      throw new AppError("Agent ID is required", 400);
    }

    if (!targetHost) {
      throw new AppError("Target host is required", 400);
    }

    if (!targetPort) {
      throw new AppError("Target port is required", 400);
    }

    logger.info(
      `Adding TCP route for ${agentId}.${this.mongoDomain} to ${targetHost}:${targetPort}`
    );

    return withRetry(
      async () => {
        try {
          // Generate backend name
          const backendName = `${agentId}-mongo-backend`;

          // Generate domain
          const domain = `${agentId}.${this.mongoDomain}`;

          // Create backend options
          const backendOptions = {
            mode: "tcp",
            options: [],
            servers: [
              {
                name: `${agentId}-mongo-server`,
                url: `${targetHost}:${targetPort}`,
                check: options.check !== false,
                ssl: options.useTls !== false,
                sni: domain,
              },
            ],
          };

          // Add backend to HAProxy config
          await this.haproxyManager.addBackend(backendName, backendOptions);

          // Add frontend rule for TCP
          const aclName = `agent-${agentId}`;
          const condition = `req_ssl_sni -i ${domain}`;

          await this.haproxyManager.addFrontendRule(
            "tcp-in",
            backendName,
            condition,
            aclName
          );

          // Apply configuration
          await this.haproxyManager.applyConfig();

          // Update cache
          this.routeCache.set(`tcp:${agentId}:mongo`, {
            name: backendName,
            domain,
            targetUrl: `${targetHost}:${targetPort}`,
            aclName,
            lastUpdated: new Date().toISOString(),
          });

          return {
            success: true,
            agentId,
            domain,
            targetHost,
            targetPort,
            type: "tcp",
          };
        } catch (err) {
          // Log and rethrow to allow retry
          logger.error(`Error adding TCP route: ${err.message}`, {
            error: err.message,
            stack: err.stack,
          });

          throw err;
        }
      },
      {
        maxRetries: 3,
        initialDelay: 1000,
        onRetry: (err, attempt) => {
          logger.warn(`Retry ${attempt} adding TCP route (${err.message})`);
        },
      }
    );
  }

  /**
   * Remove a route (HTTP or TCP)
   *
   * @param {string} agentId - The agent ID
   * @param {string} subdomain - The subdomain (for HTTP routes) or 'mongo' (for TCP routes)
   * @param {string} type - Route type ('http' or 'tcp')
   * @returns {Promise<Object>} Result
   */
  async removeRoute(agentId, subdomain, type = "http") {
    if (!this.initialized) {
      await this.initialize();
    }

    return withRetry(
      async () => {
        try {
          logger.info(
            `Removing ${type} route for agent ${agentId}, subdomain ${subdomain}`
          );

          // Check cache
          const cacheKey = `${type}:${agentId}:${subdomain}`;
          const cachedRoute = this.routeCache.get(cacheKey);

          if (!cachedRoute) {
            logger.warn(
              `Route ${cacheKey} not found in cache, trying to remove anyway`
            );
          }

          // Generate backend name based on type
          const backendName =
            type === "tcp"
              ? `${agentId}-mongo-backend`
              : `${agentId}-${subdomain}-backend`;

          // Remove the backend and all related frontend rules
          await this.haproxyManager.removeBackend(backendName);

          // Apply configuration
          await this.haproxyManager.applyConfig();

          // Remove from cache
          this.routeCache.delete(cacheKey);

          return {
            success: true,
            agentId,
            subdomain,
            type,
          };
        } catch (err) {
          // Log and rethrow to allow retry
          logger.error(`Error removing route: ${err.message}`, {
            error: err.message,
            stack: err.stack,
          });

          throw err;
        }
      },
      {
        maxRetries: 2,
        initialDelay: 500,
        onRetry: (err, attempt) => {
          logger.warn(`Retry ${attempt} removing route (${err.message})`);
        },
      }
    );
  }

  /**
   * Get all routes for an agent
   *
   * @param {string} agentId - The agent ID
   * @returns {Promise<Array>} Routes
   */
  async getAgentRoutes(agentId) {
    if (!this.initialized) {
      await this.initialize();
    }

    const routes = [];

    // Search cache for routes belonging to this agent
    for (const [key, route] of this.routeCache.entries()) {
      const [type, routeAgentId] = key.split(":");

      if (routeAgentId === agentId) {
        routes.push({
          type,
          agentId,
          ...route,
        });
      }
    }

    return routes;
  }

  /**
   * Get all routes
   *
   * @returns {Promise<Array>} All routes
   */
  async getAllRoutes() {
    if (!this.initialized) {
      await this.initialize();
    }

    const routes = [];

    // Convert cache to array
    for (const [key, route] of this.routeCache.entries()) {
      const [type, agentId, subdomain] = key.split(":");

      routes.push({
        type,
        agentId,
        subdomain,
        ...route,
      });
    }

    return routes;
  }

  /**
   * Check if a route exists
   *
   * @param {string} agentId - The agent ID
   * @param {string} subdomain - The subdomain
   * @param {string} type - Route type ('http' or 'tcp')
   * @returns {Promise<boolean>} True if route exists
   */
  async routeExists(agentId, subdomain, type = "http") {
    if (!this.initialized) {
      await this.initialize();
    }

    const cacheKey = `${type}:${agentId}:${subdomain}`;
    return this.routeCache.has(cacheKey);
  }

  /**
   * Repair HAProxy configuration if needed
   *
   * @returns {Promise<Object>} Repair result
   */
  async repairConfig() {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      logger.info("Repairing HAProxy configuration");

      // Check health first
      const healthCheck = await this.haproxyManager.checkHealth();
      if (healthCheck.healthy) {
        logger.info("HAProxy is healthy, no repair needed");
        return {
          success: true,
          repaired: false,
          message: "HAProxy is healthy, no repair needed",
        };
      }

      // Try to repair with rollback if needed
      const rolledBack = await this.haproxyManager.rollback();

      if (rolledBack) {
        logger.info(
          "Repaired HAProxy configuration by rolling back to previous version"
        );
        return {
          success: true,
          repaired: true,
          message: "Repaired by rolling back configuration",
        };
      }

      // If rollback didn't work, try restarting HAProxy
      try {
        const { execAsync } = require("../../utils/exec");
        await execAsync(
          `docker restart ${this.haproxyManager.haproxyContainer}`
        );

        logger.info("Repaired HAProxy by restarting container");
        return {
          success: true,
          repaired: true,
          message: "Repaired by restarting HAProxy container",
        };
      } catch (restartErr) {
        logger.error(`Failed to restart HAProxy: ${restartErr.message}`);
        return {
          success: false,
          repaired: false,
          message: `Failed to repair: ${restartErr.message}`,
        };
      }
    } catch (err) {
      logger.error(`Failed to repair HAProxy configuration: ${err.message}`);
      return {
        success: false,
        repaired: false,
        message: `Failed to repair: ${err.message}`,
      };
    }
  }
}

module.exports = RoutingService;
