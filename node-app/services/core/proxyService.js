/**
 * Proxy Service
 *
 * A service focused solely on proxying traffic to agent VPSs using subdomains.
 * This consolidates and streamlines routing functionality from the previous system.
 */

const logger = require("../../utils/logger").getLogger("proxyService");
const { AppError } = require("../../utils/errorHandler");
const { withRetry } = require("../../utils/retryHandler");

class ProxyService {
  constructor() {
    this.initialized = false;
    this.consulService = null; // Will be loaded during initialization
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
      // Get consul service from core services
      const coreServices = require("../core");
      this.consulService = coreServices.consulService;

      if (!this.consulService) {
        logger.error(
          "Consul service not available, proxy service will not function correctly"
        );
        return false;
      }

      this.initialized = true;
      logger.info("Proxy service initialized successfully");

      // Perform self-healing: clean up any orphaned routers
      try {
        logger.info("Performing self-healing check for orphaned routers...");
        await this.getAllRoutes(); // This will automatically clean up orphaned routers
        logger.info("Self-healing check completed");
      } catch (healErr) {
        logger.warn(
          `Self-healing check failed, but continuing: ${healErr.message}`
        );
      }

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
      throw new AppError("Subdomain is required for HTTP routes", 400);
    }

    if (!targetUrl) {
      throw new AppError("Target URL is required", 400);
    }

    logger.info(
      `Adding HTTP route for ${subdomain}.${this.appDomain} to ${targetUrl}`
    );

    // Check if Consul service is available
    if (!this.consulService || !this.consulService.isInitialized) {
      logger.error("Consul service not available for HTTP route registration");
      throw new AppError(
        "Consul service not available for route registration",
        500
      );
    }

    // Normalize targetUrl to ensure it has protocol
    if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
      targetUrl = `http://${targetUrl}`;
    }

    // Extract hostname and port from targetUrl
    let hostname, port;
    try {
      const url = new URL(targetUrl);
      hostname = url.hostname;
      port = url.port || (url.protocol === "https:" ? "443" : "80");
    } catch (err) {
      logger.error(`Invalid target URL: ${targetUrl}`, {
        error: err.message,
      });
      throw new AppError(`Invalid target URL: ${targetUrl}`, 400);
    }

    // Create agent configuration for Consul
    const agentConfig = {
      name: `${agentId}-${subdomain}`,
      subdomain: subdomain,
      hostname: hostname,
      httpPort: parseInt(port, 10),
      mongoPort: 27017, // Default MongoDB port, not used for HTTP routes
      secure: options.secure !== false,
    };

    // Prepare HTTP router and service for Consul KV
    const routerName = `${agentId}-${subdomain}`;
    const serviceName = `${routerName}-service`;

    // Create HTTP router configuration
    const router = {
      entryPoints: ["websecure"],
      rule: `Host(\`${subdomain}.${this.appDomain}\`)`,
      service: serviceName,
      tls: {
        certResolver: "letsencrypt",
      },
      priority: 200, // Higher priority than file-based routes (100)
    };

    // Create HTTP service configuration
    const service = {
      loadBalancer: {
        servers: [
          {
            url: targetUrl,
          },
        ],
      },
    };

    // Register HTTP route using Consul service
    try {
      // Debug log to verify service format before saving
      logger.debug(
        `Registering HTTP service with configuration: ${JSON.stringify(
          service
        )}`
      );

      // Ensure the service is using the correct format (url instead of address/port)
      if (!service.loadBalancer.servers[0].url) {
        logger.error(
          `Service configuration missing url property: ${JSON.stringify(
            service
          )}`
        );
        throw new AppError("Invalid service configuration", 500);
      }

      // Set service FIRST to avoid orphaned routers
      await this.consulService.addHttpService(serviceName, service);

      // Only set router after service is successfully created
      await this.consulService.addHttpRouter(routerName, router);

      logger.info(
        `Successfully registered HTTP route for ${subdomain} in Consul KV store`
      );

      // Force Traefik to reload its configuration to pick up the new route immediately
      try {
        const coreServices = require("../core");
        if (
          coreServices.certificateService &&
          coreServices.certificateService.initialized
        ) {
          logger.info(
            "Forcing Traefik to reload configuration after route update"
          );
          const reloadResult =
            await coreServices.certificateService.reloadTraefik();
          if (!reloadResult.success) {
            logger.warn(`Traefik reload failed: ${reloadResult.error}`);
          } else {
            logger.info("Traefik configuration reloaded successfully");
          }
        } else {
          logger.warn("Certificate service not available for Traefik reload");
        }
      } catch (reloadErr) {
        // Don't fail the route registration if reload fails, just log the warning
        logger.warn(
          `Failed to reload Traefik after route update: ${reloadErr.message}`
        );
      }

      return {
        success: true,
        message: `HTTP route added successfully for ${subdomain}.${this.appDomain}`,
        route: {
          agentId,
          subdomain,
          domain: `${subdomain}.${this.appDomain}`,
          targetUrl,
        },
      };
    } catch (err) {
      logger.error(
        `Failed to register HTTP route for ${subdomain} in Consul: ${err.message}`
      );

      // Cleanup orphaned router/service if they were partially created
      try {
        logger.warn(
          `Cleaning up potentially orphaned router/service for ${routerName}`
        );
        await this.consulService.delete(`http/routers/${routerName}`);
        await this.consulService.delete(`http/services/${serviceName}`);
      } catch (cleanupErr) {
        logger.warn(`Cleanup failed, but continuing: ${cleanupErr.message}`);
      }

      throw new AppError(
        `Failed to register route in Consul KV store: ${err.message}`,
        500
      );
    }
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

    // Check if Consul service is available
    if (!this.consulService || !this.consulService.isInitialized) {
      logger.error("Consul service not available for HTTP route removal");
      throw new AppError("Consul service not available for route removal", 500);
    }

    // Prepare router and service names
    const routerName = `${agentId}-${subdomain}`;
    const serviceName = `${routerName}-service`;

    // Remove route using Consul service
    let consulResult = false;
    try {
      // Delete router and service from Consul
      await this.consulService.delete(`http/routers/${routerName}`);
      await this.consulService.delete(`http/services/${serviceName}`);
      consulResult = true;
    } catch (err) {
      logger.error(
        `Failed to remove HTTP route for ${subdomain} from Consul: ${err.message}`
      );
      throw new AppError("Failed to remove route from Consul KV store", 500);
    }

    if (!consulResult) {
      logger.error(`Failed to remove HTTP route for ${subdomain} from Consul`);
      throw new AppError("Failed to remove route from Consul KV store", 500);
    }

    logger.info(
      `Successfully removed HTTP route for ${subdomain} from Consul KV store`
    );

    // Force Traefik to reload its configuration to remove the route immediately
    try {
      const coreServices = require("../core");
      if (
        coreServices.certificateService &&
        coreServices.certificateService.initialized
      ) {
        logger.info(
          "Forcing Traefik to reload configuration after route removal"
        );
        const reloadResult =
          await coreServices.certificateService.reloadTraefik();
        if (!reloadResult.success) {
          logger.warn(`Traefik reload failed: ${reloadResult.error}`);
        } else {
          logger.info("Traefik configuration reloaded successfully");
        }
      } else {
        logger.warn("Certificate service not available for Traefik reload");
      }
    } catch (reloadErr) {
      // Don't fail the route removal if reload fails, just log the warning
      logger.warn(
        `Failed to reload Traefik after route removal: ${reloadErr.message}`
      );
    }

    return {
      success: true,
      message: `HTTP route for ${subdomain}.${this.appDomain} removed successfully`,
    };
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

    // Check if Consul service is available
    if (!this.consulService || !this.consulService.isInitialized) {
      logger.error("Consul service not available for retrieving agent routes");
      throw new AppError("Consul service not available", 500);
    }

    try {
      // Get all HTTP routers from Consul
      const httpRouters = await this.consulService.get("http/routers");
      const routes = { http: [], mongodb: [] };

      if (httpRouters) {
        // Filter routers that belong to this agent
        for (const [name, router] of Object.entries(httpRouters)) {
          if (
            name.startsWith(`${agentId}-`) &&
            !name.includes("dashboard") &&
            !name.includes("traefik-healthcheck")
          ) {
            // Get the service details
            const serviceName = router.service;
            const service = await this.consulService.get(
              `http/services/${serviceName}`
            );

            if (service) {
              // Extract subdomain from name, removing potential service suffix
              const nameParts = name.replace(`${agentId}-`, "").split("-");
              let subdomain;

              // Handle both formats: "agentId-subdomain" and "agentId-subdomain-service"
              if (nameParts[nameParts.length - 1] === "service") {
                subdomain = nameParts.slice(0, -1).join("-");
              } else {
                subdomain = nameParts.join("-");
              }

              // Extract target URL from service, handling both format types (url or address/port)
              let targetUrl = "unknown";
              if (service.loadBalancer?.servers?.[0]) {
                const server = service.loadBalancer.servers[0];
                if (server.url) {
                  targetUrl = server.url;
                } else if (server.address && server.port) {
                  // Convert address/port format to URL format
                  targetUrl = `http://${server.address}:${server.port}`;

                  // Fix the service configuration to use URL format
                  logger.warn(
                    `Found HTTP service using address/port format instead of URL. Fixing for ${name}`
                  );
                  const fixedService = {
                    ...service,
                    loadBalancer: {
                      servers: [{ url: targetUrl }],
                    },
                  };

                  // Update the service in Consul
                  try {
                    await this.consulService.set(
                      `http/services/${serviceName}`,
                      fixedService
                    );
                    logger.info(`Fixed service configuration for ${name}`);
                  } catch (fixErr) {
                    logger.error(
                      `Failed to fix service configuration: ${fixErr.message}`
                    );
                  }
                }
              }

              routes.http.push({
                agentId,
                subdomain,
                domain: `${subdomain}.${this.appDomain}`,
                rule: router.rule,
                targetUrl,
              });
            }
          }
        }
      }

      // Get MongoDB routers for this agent
      const tcpRouters = await this.consulService.get("tcp/routers");

      if (tcpRouters && tcpRouters[agentId]) {
        const mongoRouter = tcpRouters[agentId];
        const mongoService = await this.consulService.get(
          `tcp/services/${agentId}-mongo`
        );

        if (mongoService) {
          routes.mongodb.push({
            agentId,
            domain: `${agentId}.${this.mongoDomain}`,
            rule: mongoRouter.rule,
            target:
              mongoService.loadBalancer?.servers?.[0]?.address || "unknown",
          });
        }
      }

      // Combine routes into a flat array with type field
      const flatRoutes = [
        ...routes.http.map((route) => ({ ...route, type: "http" })),
        ...routes.mongodb.map((route) => ({ ...route, type: "mongodb" })),
      ];

      return {
        success: true,
        routes: flatRoutes,
        routesByType: routes, // Keep the old structure for backward compatibility
      };
    } catch (error) {
      logger.error(`Error retrieving agent routes: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });

      return {
        success: false,
        error: `Failed to retrieve agent routes: ${error.message}`,
        routes: [], // Add empty routes array to prevent "some is not a function" errors
        routesByType: { http: [], mongodb: [] }, // Add empty routesByType to prevent "routeInfo.routes.some is not a function"
      };
    }
  }

  /**
   * Get all routes
   * @returns {Promise<Object>} All routes
   */
  async getAllRoutes() {
    if (!this.initialized) {
      await this.initialize();
    }

    // Check if Consul service is available
    if (!this.consulService || !this.consulService.isInitialized) {
      logger.error("Consul service not available for retrieving all routes");
      return {
        success: false,
        error: "Consul service not available",
        routes: [],
        routesByType: { http: [], mongodb: [] },
      };
    }

    try {
      // Get all HTTP routers (use recursive list so we see each child key)
      const httpRouters = await this.consulService.get("http/routers", {
        recurse: true,
      });
      const tcpRouters = await this.consulService.get("tcp/routers");

      const routes = { http: [], mongodb: [] };

      // Process HTTP routes
      if (httpRouters) {
        for (const [name, router] of Object.entries(httpRouters)) {
          // Skip special routers like traefik dashboard
          if (
            name === "dashboard" ||
            name === "traefik-healthcheck" ||
            name === "http-catchall" ||
            name.includes("/") // Skip nested keys like "agentId/entryPoints/0"
          ) {
            continue;
          }

          // Ensure router is an object with expected properties
          if (!router || typeof router !== "object" || !router.service) {
            logger.warn(`Router ${name} has no service defined, skipping`);
            continue;
          }

          try {
            // Get the service details
            const serviceName = router.service;

            const service = await this.consulService.get(
              `http/services/${serviceName}`
            );

            if (!service) {
              // Auto-fix orphaned router: remove it to prevent Traefik errors
              logger.warn(
                `Found orphaned router ${name} with missing service ${serviceName}, removing it`
              );
              try {
                await this.consulService.delete(`http/routers/${name}`);
                logger.info(`Successfully removed orphaned router ${name}`);
              } catch (removeErr) {
                logger.error(
                  `Failed to remove orphaned router ${name}: ${removeErr.message}`
                );
              }
              continue;
            }

            if (service) {
              // Extract agent ID and subdomain from name
              const parts = name.split("-");
              if (parts.length >= 2) {
                const agentId = parts[0];
                let subdomain;

                // Handle both formats: "agentId-subdomain" and "agentId-subdomain-service"
                if (parts[parts.length - 1] === "service") {
                  subdomain = parts.slice(1, -1).join("-");
                } else {
                  subdomain = parts.slice(1).join("-");
                }

                // Extract target URL from service, handling both format types (url or address/port)
                let targetUrl = "unknown";
                if (service.loadBalancer?.servers?.[0]) {
                  const server = service.loadBalancer.servers[0];
                  if (server.url) {
                    targetUrl = server.url;
                  } else if (server.address && server.port) {
                    // Convert address/port format to URL format
                    targetUrl = `http://${server.address}:${server.port}`;

                    // Fix the service configuration to use URL format
                    logger.warn(
                      `Found HTTP service using address/port format instead of URL. Fixing for ${name}`
                    );
                    const fixedService = {
                      ...service,
                      loadBalancer: {
                        servers: [{ url: targetUrl }],
                      },
                    };

                    // Update the service in Consul
                    try {
                      await this.consulService.set(
                        `http/services/${serviceName}`,
                        fixedService
                      );
                      logger.info(`Fixed service configuration for ${name}`);
                    } catch (fixErr) {
                      logger.error(
                        `Failed to fix service configuration: ${fixErr.message}`
                      );
                    }
                  }
                }

                routes.http.push({
                  agentId,
                  subdomain,
                  domain: `${subdomain}.${this.appDomain}`,
                  rule: router.rule,
                  targetUrl,
                  lastUpdated: new Date().toISOString(),
                });
              }
            }
          } catch (error) {
            logger.error(`Error processing router ${name}: ${error.message}`, {
              error: error.message,
              stack: error.stack,
            });
          }
        }
      }

      // Process MongoDB routes
      if (tcpRouters) {
        for (const [name, router] of Object.entries(tcpRouters)) {
          // Get the service details
          const serviceName = router.service;
          const service = await this.consulService.get(
            `tcp/services/${serviceName}`
          );

          if (service) {
            routes.mongodb.push({
              agentId: name,
              domain: `${name}.${this.mongoDomain}`,
              rule: router.rule,
              target: service.loadBalancer?.servers?.[0]?.address || "unknown",
            });
          }
        }
      }

      // Combine routes into a flat array with type field
      const flatRoutes = [
        ...routes.http.map((route) => ({ ...route, type: "http" })),
        ...routes.mongodb.map((route) => ({ ...route, type: "mongodb" })),
      ];

      return {
        success: true,
        routes: flatRoutes,
        routesByType: routes, // Keep the old structure for backward compatibility
      };
    } catch (error) {
      logger.error(`Error retrieving all routes: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });

      return {
        success: false,
        error: `Failed to retrieve all routes: ${error.message}`,
        routes: [], // Add empty routes array to prevent "some is not a function" errors
        routesByType: { http: [], mongodb: [] }, // Add empty routesByType to prevent "routes.some is not a function"
      };
    }
  }

  /**
   * Check proxy health
   * @returns {Promise<Object>} Health status
   */
  async checkHealth() {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      // Simple health check: Check if Consul is accessible
      const isHealthy = await withRetry(
        async () => {
          try {
            if (!this.consulService || !this.consulService.isInitialized) {
              return {
                healthy: false,
                error: "Consul service not initialized",
              };
            }

            // Try to get a value from Consul as a health check
            const testResult = await this.consulService.get("http/routers");
            return {
              healthy: testResult !== null,
              details: { consulReachable: testResult !== null },
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
        // Try to re-initialize consul service
        if (!this.consulService || !this.consulService.isInitialized) {
          // Re-initialize the entire service
          this.initialized = false;
          const reinitialized = await this.initialize();

          if (reinitialized) {
            return {
              success: true,
              message: "Consul service reinitialized successfully",
              action: "reinitialized",
            };
          } else {
            return {
              success: false,
              message: "Failed to reinitialize Consul service",
              action: "none",
            };
          }
        }

        // Try to re-initialize the Consul KV structure
        try {
          await this.consulService.initializeKeyStructure();
          return {
            success: true,
            message: "Consul key structure reinitialized",
            action: "reinitialized-keys",
          };
        } catch (err) {
          logger.error(`Failed to reinitialize Consul keys: ${err.message}`, {
            error: err.message,
            stack: err.stack,
          });

          return {
            success: false,
            message: `Failed to repair: ${err.message}`,
            action: "none",
          };
        }
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
