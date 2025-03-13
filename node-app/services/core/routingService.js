/**
 * Routing Service
 *
 * Centralized service for HTTP and TCP routing configuration.
 */

const configService = require("./configService");
const mongodbService = require("./mongodbService");
const logger = require("../../utils/logger").getLogger("routingService");
const Docker = require("dockerode");

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

class RoutingService {
  constructor() {
    this.appDomain = process.env.APP_DOMAIN || "apps.cloudlunacy.uk";
    this.initialized = false;
    this.routeCache = new Map(); // Cache of routes to avoid unnecessary updates
  }

  /**
   * Initialize the routing service
   */
  async initialize() {
    if (this.initialized) {
      return true;
    }

    try {
      logger.info("Initializing routing service");

      // Load existing routes into cache
      await this.loadExistingRoutes();

      this.initialized = true;
      logger.info("Routing service initialized successfully");
      return true;
    } catch (err) {
      logger.error(`Failed to initialize routing service: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      throw err;
    }
  }

  /**
   * Load existing routes into cache
   */
  async loadExistingRoutes() {
    try {
      // Load main config
      const mainConfig = configService.configs.main;

      // Process HTTP routes
      if (mainConfig?.http?.routers) {
        for (const [name, router] of Object.entries(mainConfig.http.routers)) {
          this.routeCache.set(`http:${name}`, {
            type: "http",
            name,
            rule: router.rule,
            service: router.service,
            lastUpdated: new Date().toISOString(),
          });
        }
      }

      // Process TCP routes
      if (mainConfig?.tcp?.routers) {
        for (const [name, router] of Object.entries(mainConfig.tcp.routers)) {
          this.routeCache.set(`tcp:${name}`, {
            type: "tcp",
            name,
            rule: router.rule,
            service: router.service,
            lastUpdated: new Date().toISOString(),
          });
        }
      }

      logger.info(`Loaded ${this.routeCache.size} routes into cache`);
      return true;
    } catch (err) {
      logger.error(`Failed to load existing routes: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return false;
    }
  }

  /**
   * Add an HTTP route
   */
  async addHttpRoute(agentId, subdomain, targetUrl, options = {}) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info(
        `Adding HTTP route for ${subdomain}.${this.appDomain} -> ${targetUrl}`
      );

      // Validate inputs
      if (!this.validateRouteInputs(subdomain, targetUrl)) {
        throw new Error("Invalid subdomain or target URL");
      }

      // Get main config
      const mainConfig = configService.configs.main;
      if (!mainConfig) {
        throw new Error("Main configuration not loaded");
      }

      // Ensure http section exists
      if (!mainConfig.http) {
        mainConfig.http = { routers: {}, services: {} };
      }
      if (!mainConfig.http.routers) {
        mainConfig.http.routers = {};
      }
      if (!mainConfig.http.services) {
        mainConfig.http.services = {};
      }

      // Create router name
      const routerName = `${agentId}-${subdomain}`;

      // Create router
      mainConfig.http.routers[routerName] = {
        rule: `Host(\`${subdomain}.${this.appDomain}\`)`,
        service: `${routerName}-service`,
        entryPoints: ["web", "websecure"],
        tls: {
          certResolver: "letsencrypt",
        },
      };

      // Create service
      mainConfig.http.services[`${routerName}-service`] = {
        loadBalancer: {
          servers: [{ url: targetUrl }],
        },
      };

      // Save updated config
      await configService.saveConfig(configService.paths.dynamic, mainConfig);

      // Add to cache
      this.routeCache.set(`http:${routerName}`, {
        type: "http",
        name: routerName,
        domain: `${subdomain}.${this.appDomain}`,
        targetUrl,
        lastUpdated: new Date().toISOString(),
      });

      return {
        success: true,
        domain: `${subdomain}.${this.appDomain}`,
        targetUrl,
        agentId,
      };
    } catch (err) {
      logger.error(`Failed to add HTTP route: ${err.message}`, {
        error: err.message,
        stack: err.stack,
        subdomain,
        targetUrl,
        agentId,
      });
      throw err;
    }
  }

  /**
   * Validate route inputs
   * @private
   */
  validateRouteInputs(subdomain, targetUrl) {
    // Validate subdomain (alphanumeric and hyphens)
    const validSubdomain = /^[a-z0-9-]+$/.test(subdomain);

    // Validate target URL
    const validUrl = /^(?:https?:\/\/)?[a-zA-Z0-9.-]+(?::\d+)?(?:\/.*)?$/.test(
      targetUrl
    );

    if (!validSubdomain) {
      logger.warn(`Invalid subdomain format: ${subdomain}`);
    }

    if (!validUrl) {
      logger.warn(`Invalid target URL format: ${targetUrl}`);
    }

    return validSubdomain && validUrl;
  }

  /**
   * Remove an HTTP route
   */
  async removeHttpRoute(agentId, subdomain) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info(`Removing HTTP route for ${subdomain}.${this.appDomain}`);

      // Check if route exists
      const routeName = `${agentId}-${subdomain}`;
      const cacheKey = `http:${routeName}`;

      if (!this.routeCache.has(cacheKey)) {
        return {
          success: false,
          error: `Route for ${subdomain}.${this.appDomain} not found`,
        };
      }

      // Get main config
      const mainConfig = configService.configs.main;

      // Remove from HTTP routers
      if (mainConfig?.http?.routers?.[routeName]) {
        delete mainConfig.http.routers[routeName];
      }

      // Remove from HTTP services
      if (mainConfig?.http?.services?.[`${routeName}-service`]) {
        delete mainConfig.http.services[`${routeName}-service`];
      }

      // Save updated config
      await configService.saveConfig(configService.paths.dynamic, mainConfig);

      // Remove from cache
      this.routeCache.delete(cacheKey);

      return {
        success: true,
        domain: `${subdomain}.${this.appDomain}`,
        agentId,
      };
    } catch (err) {
      logger.error(`Failed to remove HTTP route: ${err.message}`, {
        error: err.message,
        stack: err.stack,
        subdomain,
        agentId,
      });
      throw err;
    }
  }

  /**
   * Repair routing configuration
   */
  async repair() {
    try {
      logger.info("Repairing routing configuration");

      // Reload routes
      this.routeCache.clear();
      await this.loadExistingRoutes();

      return true;
    } catch (err) {
      logger.error(`Failed to repair routing configuration: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return false;
    }
  }
}

module.exports = new RoutingService();
