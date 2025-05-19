/**
 * App Registration Service for Consul
 *
 * Handles registration and management of apps in Consul KV store for Traefik routing.
 */

const logger = require("../../utils/logger").getLogger(
  "appRegistrationService"
);
const ConsulService = require("./consulService");

class AppRegistrationService {
  constructor() {
    this.consulService = null;
    this.initialized = false;
    this.appDomain = process.env.APP_DOMAIN || "apps.cloudlunacy.uk";
  }

  /**
   * Initialize the service
   */
  async initialize() {
    if (this.initialized) {
      return true;
    }

    try {
      // Get consul service from core services
      if (!this.consulService) {
        const coreServices = require("../core");
        this.consulService = coreServices.consulService;
      }

      // Wait for Consul service to be available
      if (!this.consulService) {
        logger.warn("Consul service not yet available, will try again later");
        return false;
      }

      // Wait for Consul service to be initialized
      if (!this.consulService.isInitialized) {
        try {
          await this.consulService.initialize();
        } catch (consulErr) {
          logger.warn(
            `Failed to initialize Consul service: ${consulErr.message}`
          );
        }
      }

      // Final check if Consul is initialized - only mark as initialized if Consul is ready
      if (!this.consulService.isInitialized) {
        logger.error(
          "Consul service not initialized, app registration service will not function properly"
        );
        this.initialized = false;
        return false;
      }

      // Only set initialized to true when both this service and ConsulService are fully initialized
      this.initialized = true;
      logger.info("App registration service initialized successfully");
      return true;
    } catch (err) {
      logger.error(
        `Failed to initialize app registration service: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
        }
      );
      this.initialized = false;
      return false;
    }
  }

  /**
   * Register a new app
   * @param {string} agentId - Agent ID
   * @param {string} subdomain - Subdomain for the app
   * @param {string} targetUrl - Target URL to proxy to
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Result
   */
  async registerApp(agentId, subdomain, targetUrl, options = {}) {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // Prepare HTTP router and service
      const routerName = `${agentId}-${subdomain}`;
      const serviceName = `${routerName}-service`;

      // Create HTTP router configuration
      const router = {
        entryPoints: ["websecure"],
        rule: `Host(\`${subdomain}.${this.appDomain}\`)`,
        service: serviceName,
        middlewares: ["app-routing"],
        tls: {
          certResolver: "letsencrypt",
        },
        priority: 110,
      };

      // Create HTTP service configuration
      const service = {
        loadBalancer: {
          servers: [{ url: targetUrl }],
        },
      };

      // Set router and service in Consul
      await this.consulService.set(`http/routers/${routerName}`, router);
      await this.consulService.set(`http/services/${serviceName}`, service);

      logger.info(
        `Registered app ${subdomain}.${this.appDomain} -> ${targetUrl}`
      );
      return {
        success: true,
        routerName,
        serviceName,
        domain: `${subdomain}.${this.appDomain}`,
        targetUrl,
      };
    } catch (err) {
      logger.error(`Failed to register app ${subdomain}: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Unregister an app
   * @param {string} agentId - Agent ID
   * @param {string} subdomain - Subdomain for the app
   * @returns {Promise<Object>} Result
   */
  async unregisterApp(agentId, subdomain) {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // Prepare router and service names
      const routerName = `${agentId}-${subdomain}`;
      const serviceName = `${routerName}-service`;

      // Delete router and service from Consul
      await this.consulService.delete(`http/routers/${routerName}`);
      await this.consulService.delete(`http/services/${serviceName}`);

      logger.info(`Unregistered app ${subdomain}.${this.appDomain}`);
      return {
        success: true,
        routerName,
        serviceName,
      };
    } catch (err) {
      logger.error(`Failed to unregister app ${subdomain}: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Get all registered apps
   * @returns {Promise<Array>} List of registered apps
   */
  async getAllApps() {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const httpRouters = await this.consulService.get("http/routers");
      const apps = [];

      if (httpRouters) {
        for (const [name, router] of Object.entries(httpRouters)) {
          // Skip special routers
          if (
            ["dashboard", "traefik-healthcheck", "api", "apps"].includes(name)
          ) {
            continue;
          }

          // Get the service details
          const serviceName = router.service;
          const service = await this.consulService.get(
            `http/services/${serviceName}`
          );

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

              apps.push({
                agentId,
                subdomain,
                domain: `${subdomain}.${this.appDomain}`,
                rule: router.rule,
                targetUrl: service.loadBalancer?.servers?.[0]?.url || "unknown",
                lastUpdated: new Date().toISOString(),
              });
            }
          }
        }
      }

      return apps;
    } catch (err) {
      logger.error(`Failed to get all apps: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return [];
    }
  }

  /**
   * Get apps for a specific agent
   * @param {string} agentId - Agent ID
   * @returns {Promise<Array>} List of apps for the agent
   */
  async getAgentApps(agentId) {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const httpRouters = await this.consulService.get("http/routers");
      const apps = [];

      if (httpRouters) {
        for (const [name, router] of Object.entries(httpRouters)) {
          // Filter by agent ID and skip special routers
          if (
            !name.startsWith(`${agentId}-`) ||
            ["dashboard", "traefik-healthcheck", "api", "apps"].includes(name)
          ) {
            continue;
          }

          // Get the service details
          const serviceName = router.service;
          const service = await this.consulService.get(
            `http/services/${serviceName}`
          );

          if (service) {
            // Extract subdomain from name
            const parts = name.replace(`${agentId}-`, "").split("-");
            let subdomain;

            // Handle both formats: "subdomain" and "subdomain-service"
            if (parts[parts.length - 1] === "service") {
              subdomain = parts.slice(0, -1).join("-");
            } else {
              subdomain = parts.join("-");
            }

            apps.push({
              agentId,
              subdomain,
              domain: `${subdomain}.${this.appDomain}`,
              rule: router.rule,
              targetUrl: service.loadBalancer?.servers?.[0]?.url || "unknown",
              lastUpdated: new Date().toISOString(),
            });
          }
        }
      }

      return apps;
    } catch (err) {
      logger.error(`Failed to get apps for agent ${agentId}: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return [];
    }
  }
}

module.exports = AppRegistrationService;
