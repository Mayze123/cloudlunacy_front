// services/routingManager.js
/**
 * Routing Manager
 *
 * Handles HTTP and TCP routing configuration for Traefik
 */

const configManager = require("./configManager");
const mongodbManager = require("./mongodbManager");
const logger = require("../utils/logger").getLogger("routingManager");
const Docker = require("dockerode");

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

class RoutingManager {
  constructor() {
    this.appDomain = process.env.APP_DOMAIN || "apps.cloudlunacy.uk";
    this.initialized = false;
    this.routeCache = new Map(); // Cache of routes to avoid unnecessary updates
  }

  /**
   * Initialize the routing manager
   */
  async initialize() {
    if (this.initialized) {
      return true;
    }

    try {
      logger.info("Initializing routing manager");

      // Initialize config manager
      await configManager.initialize();

      // Load existing routes into cache
      await this.loadExistingRoutes();

      this.initialized = true;
      logger.info("Routing manager initialized successfully");
      return true;
    } catch (err) {
      logger.error(`Failed to initialize routing manager: ${err.message}`, {
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
      const mainConfig = configManager.configs.main;

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

      // Process agent configs
      const agents = await configManager.listAgents();
      for (const agentId of agents) {
        const agentConfig = await configManager.getAgentConfig(agentId);

        // Process HTTP routes
        if (agentConfig?.http?.routers) {
          for (const [name, router] of Object.entries(
            agentConfig.http.routers
          )) {
            this.routeCache.set(`http:${agentId}:${name}`, {
              type: "http",
              name,
              agentId,
              rule: router.rule,
              service: router.service,
              lastUpdated: new Date().toISOString(),
            });
          }
        }

        // Process TCP routes
        if (agentConfig?.tcp?.routers) {
          for (const [name, router] of Object.entries(
            agentConfig.tcp.routers
          )) {
            this.routeCache.set(`tcp:${agentId}:${name}`, {
              type: "tcp",
              name,
              agentId,
              rule: router.rule,
              service: router.service,
              lastUpdated: new Date().toISOString(),
            });
          }
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
   * Add a new HTTP route
   */
  async addHttpRoute(agentId, subdomain, targetUrl, options = {}) {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      logger.info(
        `Adding HTTP route for subdomain ${subdomain}.${this.appDomain}`
      );

      // Validate inputs
      if (!this.validateHttpInputs(subdomain, targetUrl)) {
        throw new Error("Invalid subdomain or target URL");
      }

      // Get agent configuration
      const config = await configManager.getAgentConfig(agentId);

      // Extract targetHost from URL for host header
      let targetHost;
      try {
        const url = new URL(
          targetUrl.startsWith("http") ? targetUrl : `http://${targetUrl}`
        );
        targetHost = url.host; // hostname:port
      } catch (err) {
        logger.warn(`Failed to parse URL ${targetUrl}: ${err.message}`);
        targetHost = targetUrl;
      }

      // Set up routes
      const middlewareName = `${subdomain}-host-rewrite`;
      const protocol = options.protocol || "http";

      config.http = config.http || {
        routers: {},
        services: {},
        middlewares: {},
      };
      config.http.routers = config.http.routers || {};
      config.http.services = config.http.services || {};
      config.http.middlewares = config.http.middlewares || {};

      // Create middleware for host rewriting
      config.http.middlewares[middlewareName] = {
        headers: {
          customRequestHeaders: {
            Host: targetHost,
          },
        },
      };

      // Create router
      config.http.routers[subdomain] = {
        rule: `Host(\`${subdomain}.${this.appDomain}\`)`,
        service: `${subdomain}-service`,
        entryPoints: ["web", "websecure"],
        middlewares: [middlewareName],
        tls: {
          certResolver: "letsencrypt",
        },
      };

      // Create service
      config.http.services[`${subdomain}-service`] = {
        loadBalancer: {
          servers: [
            {
              url: targetUrl.startsWith(protocol)
                ? targetUrl
                : `${protocol}://${targetUrl}`,
            },
          ],
        },
      };

      // Save the configuration
      await configManager.saveAgentConfig(agentId, config);

      // Update route cache
      this.routeCache.set(`http:${agentId}:${subdomain}`, {
        type: "http",
        name: subdomain,
        agentId,
        rule: `Host(\`${subdomain}.${this.appDomain}\`)`,
        service: `${subdomain}-service`,
        lastUpdated: new Date().toISOString(),
      });

      // Reload Traefik configuration
      await this.reloadTraefik();

      return {
        success: true,
        subdomain,
        domain: `${subdomain}.${this.appDomain}`,
        targetUrl: targetUrl.startsWith(protocol)
          ? targetUrl
          : `${protocol}://${targetUrl}`,
      };
    } catch (err) {
      logger.error(`Failed to add HTTP route: ${err.message}`, {
        error: err.message,
        stack: err.stack,
        agentId,
        subdomain,
        targetUrl,
      });
      throw err;
    }
  }

  /**
   * Add a new TCP route
   */
  async addTcpRoute(agentId, name, targetHost, targetPort, options = {}) {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const domain = options.domain || this.appDomain;
      logger.info(`Adding TCP route for ${name}.${domain}`);

      // Validate inputs
      if (!this.validateTcpInputs(name, targetHost, targetPort)) {
        throw new Error("Invalid name, target host, or port");
      }

      // Get agent configuration
      const config = await configManager.getAgentConfig(agentId);

      // Set up TCP route
      config.tcp = config.tcp || { routers: {}, services: {} };
      config.tcp.routers = config.tcp.routers || {};
      config.tcp.services = config.tcp.services || {};

      // Create router
      config.tcp.routers[name] = {
        rule: `HostSNI(\`${name}.${domain}\`)`,
        service: `${name}-service`,
        entryPoints: options.entryPoints || ["tcp"],
        tls: options.tls || undefined,
      };

      // Create service
      config.tcp.services[`${name}-service`] = {
        loadBalancer: {
          servers: [{ address: `${targetHost}:${targetPort}` }],
        },
      };

      // Save the configuration
      await configManager.saveAgentConfig(agentId, config);

      // Update route cache
      this.routeCache.set(`tcp:${agentId}:${name}`, {
        type: "tcp",
        name,
        agentId,
        rule: `HostSNI(\`${name}.${domain}\`)`,
        service: `${name}-service`,
        lastUpdated: new Date().toISOString(),
      });

      // Reload Traefik configuration
      await this.reloadTraefik();

      return {
        success: true,
        name,
        domain: `${name}.${domain}`,
        targetAddress: `${targetHost}:${targetPort}`,
      };
    } catch (err) {
      logger.error(`Failed to add TCP route: ${err.message}`, {
        error: err.message,
        stack: err.stack,
        agentId,
        name,
        targetHost,
        targetPort,
      });
      throw err;
    }
  }

  /**
   * Remove a route
   */
  async removeRoute(agentId, name, type = "http") {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      logger.info(`Removing ${type} route ${name} for agent ${agentId}`);

      // Get agent configuration
      const config = await configManager.getAgentConfig(agentId);

      // Remove route based on type
      if (type === "http" && config.http?.routers?.[name]) {
        // Get service name
        const serviceName = config.http.routers[name].service;

        // Remove router
        delete config.http.routers[name];

        // Remove service if it exists
        if (serviceName && config.http.services?.[serviceName]) {
          delete config.http.services[serviceName];
        }

        // Remove middleware if it exists
        const middlewareName = `${name}-host-rewrite`;
        if (config.http.middlewares?.[middlewareName]) {
          delete config.http.middlewares[middlewareName];
        }

        // Remove from cache
        this.routeCache.delete(`http:${agentId}:${name}`);
      } else if (type === "tcp" && config.tcp?.routers?.[name]) {
        // Get service name
        const serviceName = config.tcp.routers[name].service;

        // Remove router
        delete config.tcp.routers[name];

        // Remove service if it exists
        if (serviceName && config.tcp.services?.[serviceName]) {
          delete config.tcp.services[serviceName];
        }

        // Remove from cache
        this.routeCache.delete(`tcp:${agentId}:${name}`);
      } else {
        throw new Error(
          `Route ${name} of type ${type} not found for agent ${agentId}`
        );
      }

      // Save the configuration
      await configManager.saveAgentConfig(agentId, config);

      // Reload Traefik configuration
      await this.reloadTraefik();

      return {
        success: true,
        message: `Route ${name} of type ${type} removed for agent ${agentId}`,
      };
    } catch (err) {
      logger.error(`Failed to remove route: ${err.message}`, {
        error: err.message,
        stack: err.stack,
        agentId,
        name,
        type,
      });
      throw err;
    }
  }

  /**
   * List all routes
   */
  async listRoutes(options = {}) {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const { agentId, type } = options;
      const routes = [];

      // Filter routes based on options
      for (const [, route] of this.routeCache) {
        if (agentId && route.agentId !== agentId) {
          continue;
        }

        if (type && route.type !== type) {
          continue;
        }

        routes.push(route);
      }

      return {
        success: true,
        routes,
        count: routes.length,
      };
    } catch (err) {
      logger.error(`Failed to list routes: ${err.message}`, {
        error: err.message,
        stack: err.stack,
        options,
      });

      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Reload Traefik configuration
   */
  async reloadTraefik() {
    try {
      logger.info("Reloading Traefik configuration");

      // Find the Traefik container
      const containers = await docker.listContainers({
        filters: { name: ["traefik"] },
      });

      if (containers.length === 0) {
        logger.warn("No Traefik container found, cannot reload");
        return false;
      }

      const traefikContainer = docker.getContainer(containers[0].Id);

      // Restart the container
      await traefikContainer.restart({ t: 10 }); // 10 seconds timeout

      // Wait for container to start
      await new Promise((resolve) => setTimeout(resolve, 5000));

      logger.info("Traefik configuration reloaded successfully");
      return true;
    } catch (err) {
      logger.error(`Failed to reload Traefik configuration: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return false;
    }
  }

  /**
   * Validate HTTP route inputs
   */
  validateHttpInputs(subdomain, targetUrl) {
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
   * Validate TCP route inputs
   */
  validateTcpInputs(name, targetHost, targetPort) {
    // Validate name (alphanumeric and hyphens)
    const validName = /^[a-z0-9-]+$/.test(name);

    // Validate target host (IP address or hostname)
    const validHost = /^[a-zA-Z0-9.-]+$/.test(targetHost);

    // Validate target port (number between 1 and 65535)
    const portNum = parseInt(targetPort);
    const validPort = !isNaN(portNum) && portNum >= 1 && portNum <= 65535;

    if (!validName) {
      logger.warn(`Invalid name format: ${name}`);
    }

    if (!validHost) {
      logger.warn(`Invalid target host format: ${targetHost}`);
    }

    if (!validPort) {
      logger.warn(`Invalid target port: ${targetPort}`);
    }

    return validName && validHost && validPort;
  }
}

module.exports = new RoutingManager();
