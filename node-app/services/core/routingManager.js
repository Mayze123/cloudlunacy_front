/**
 * Routing Manager
 *
 * Manages HTTP and TCP routes in Traefik configuration.
 */

const logger = require("../../utils/logger").getLogger("routingManager");
const { execAsync } = require("../../utils/exec");

class RoutingManager {
  constructor(configManager) {
    this.configManager = configManager;
    this.initialized = false;
    this.routeCache = new Map();
    this.appDomain = process.env.APP_DOMAIN || "apps.cloudlunacy.uk";
    this.mongoDomain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
  }

  /**
   * Initialize the routing manager
   */
  async initialize() {
    logger.info("Initializing routing manager");

    try {
      // Make sure config manager is initialized
      await this.configManager.initialize();

      // Load existing routes into cache
      await this._loadRoutesIntoCache();

      this.initialized = true;
      logger.info("Routing manager initialized successfully");
      return true;
    } catch (err) {
      logger.error(`Failed to initialize routing manager: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return false;
    }
  }

  /**
   * Add HTTP route
   *
   * @param {string} agentId - The agent ID
   * @param {string} subdomain - The subdomain
   * @param {string} targetUrl - The target URL
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Result
   */
  async addHttpRoute(agentId, subdomain, targetUrl, options = {}) {
    logger.info(`Adding HTTP route for ${subdomain} to ${targetUrl}`);

    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // Validate inputs
      if (!subdomain || !targetUrl) {
        throw new Error("Subdomain and targetUrl are required");
      }

      // Normalize target URL
      if (
        !targetUrl.startsWith("http://") &&
        !targetUrl.startsWith("https://")
      ) {
        targetUrl = `${options.protocol || "http"}://${targetUrl}`;
      }

      // Generate router and service names
      const routerName = `${agentId}-${subdomain}`;
      const serviceName = `${agentId}-${subdomain}-service`;

      // Generate domain
      const domain = `${subdomain}.${this.appDomain}`;

      // Create router configuration
      const routerConfig = {
        rule: `Host(\`${domain}\`)`,
        service: serviceName,
        entryPoints: ["web", "websecure"],
      };

      // Add TLS configuration if needed
      if (options.useTls !== false) {
        routerConfig.tls = {
          certResolver: "default",
        };
      }

      // Create service configuration
      const serviceConfig = {
        loadBalancer: {
          servers: [
            {
              url: targetUrl,
            },
          ],
        },
      };

      // Update configuration
      await this._updateConfig("http", "routers", routerName, routerConfig);
      await this._updateConfig("http", "services", serviceName, serviceConfig);

      // Update cache
      this.routeCache.set(`http:${agentId}:${subdomain}`, {
        name: routerName,
        domain,
        targetUrl,
        rule: routerConfig.rule,
        service: serviceName,
        lastUpdated: new Date().toISOString(),
      });

      return {
        success: true,
        agentId,
        subdomain,
        domain,
        targetUrl,
      };
    } catch (err) {
      logger.error(`Failed to add HTTP route: ${err.message}`, {
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
   * Remove HTTP route
   *
   * @param {string} agentId - The agent ID
   * @param {string} subdomain - The subdomain
   * @returns {Promise<Object>} Result
   */
  async removeHttpRoute(agentId, subdomain) {
    logger.info(`Removing HTTP route for ${subdomain}`);

    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // Generate router and service names
      const routerName = `${agentId}-${subdomain}`;
      const serviceName = `${agentId}-${subdomain}-service`;

      // Remove from configuration
      await this._removeConfig("http", "routers", routerName);
      await this._removeConfig("http", "services", serviceName);

      // Remove from cache
      this.routeCache.delete(`http:${agentId}:${subdomain}`);

      return {
        success: true,
        agentId,
        subdomain,
      };
    } catch (err) {
      logger.error(`Failed to remove HTTP route: ${err.message}`, {
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
   * Add TCP route
   *
   * @param {string} agentId - The agent ID
   * @param {string} domain - The domain
   * @param {string} targetAddress - The target address (IP:port)
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Result
   */
  async addTcpRoute(agentId, domain, targetAddress, options = {}) {
    logger.info(`Adding TCP route for ${domain} to ${targetAddress}`);

    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // Validate inputs
      if (!domain || !targetAddress) {
        throw new Error("Domain and targetAddress are required");
      }

      // Validate and normalize target address format
      if (!targetAddress.includes(":")) {
        // If port is not specified, use default MongoDB port
        targetAddress = `${targetAddress}:27017`;
      }

      // Check if the address is in a valid format
      const [host, port] = targetAddress.split(":");
      if (!host || !port || isNaN(parseInt(port))) {
        throw new Error(
          `Invalid target address format: ${targetAddress}. Expected format: host:port`
        );
      }

      // Generate router and service names
      const routerName = `mongodb-${agentId}`;
      const serviceName = `mongodb-${agentId}-service`;

      // Create router configuration
      const routerConfig = {
        rule: `HostSNI(\`${domain}\`)`,
        service: serviceName,
        entryPoints: ["mongodb"],
      };

      // Add TLS configuration if needed
      if (options.useTls !== false) {
        routerConfig.tls = {
          passthrough: true,
        };
      }

      // Create service configuration
      const serviceConfig = {
        loadBalancer: {
          servers: [
            {
              address: targetAddress,
            },
          ],
          terminationDelay: 100,
        },
      };

      // Update configuration
      await this._updateConfig("tcp", "routers", routerName, routerConfig);
      await this._updateConfig("tcp", "services", serviceName, serviceConfig);

      // Update cache
      this.routeCache.set(`tcp:${agentId}`, {
        name: routerName,
        domain,
        targetAddress,
        rule: routerConfig.rule,
        service: serviceName,
        lastUpdated: new Date().toISOString(),
      });

      return {
        success: true,
        agentId,
        domain,
        targetAddress,
      };
    } catch (err) {
      logger.error(`Failed to add TCP route: ${err.message}`, {
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
   * Remove TCP route
   *
   * @param {string} agentId - The agent ID
   * @returns {Promise<Object>} Result
   */
  async removeTcpRoute(agentId) {
    logger.info(`Removing TCP route for agent ${agentId}`);

    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // Check if route exists in cache
      const cacheKey = `tcp:${agentId}`;
      const routeInfo = this.routeCache.get(cacheKey);

      if (!routeInfo) {
        logger.warn(`No TCP route found for agent ${agentId} in cache`);

        // Do an additional check in the actual config to be sure
        const config = await this.configManager.getConfig("main");
        const routerName = `mongodb-${agentId}`;

        if (
          config.tcp &&
          config.tcp.routers &&
          config.tcp.routers[routerName]
        ) {
          logger.info(
            `Found TCP route for agent ${agentId} in config but not in cache, removing it`
          );
        } else {
          return {
            success: true,
            message: `No TCP route found for agent ${agentId}`,
            noActionRequired: true,
          };
        }
      }

      // Get router and service names
      const routerName = routeInfo ? routeInfo.name : `mongodb-${agentId}`;
      const serviceName = routeInfo
        ? routeInfo.service
        : `mongodb-${agentId}-service`;

      // Remove router and service
      await this._removeConfig("tcp", "routers", routerName);
      await this._removeConfig("tcp", "services", serviceName);

      // Verify removal
      const configAfter = await this.configManager.getConfig("main");
      const routerRemoved = !(
        configAfter.tcp &&
        configAfter.tcp.routers &&
        configAfter.tcp.routers[routerName]
      );
      const serviceRemoved = !(
        configAfter.tcp &&
        configAfter.tcp.services &&
        configAfter.tcp.services[serviceName]
      );

      if (!routerRemoved || !serviceRemoved) {
        logger.warn(
          `Failed to verify removal of TCP route for agent ${agentId}`
        );
        throw new Error("Failed to remove TCP route configuration");
      }

      // Remove from cache if it exists
      if (this.routeCache.has(cacheKey)) {
        this.routeCache.delete(cacheKey);
      }

      // Reload Traefik to apply changes (only needed for TCP routes)
      try {
        // We should notify the MongoDB service to reload Traefik
        // This is a potential design improvement to make this service more modular
        logger.info(
          `Reloading Traefik after removing TCP route for agent ${agentId}`
        );

        // For now, we'll use our own reload method
        const { stdout, stderr } = await execAsync(
          'docker restart traefik || echo "Failed to restart Traefik"'
        );
        if (stderr && stderr.includes("Failed to restart Traefik")) {
          logger.warn(`Warning during Traefik restart: ${stderr}`);
        } else {
          logger.debug(`Traefik restart output: ${stdout}`);
        }
      } catch (reloadErr) {
        logger.warn(
          `Failed to reload Traefik: ${reloadErr.message}, but route was removed from config`
        );
      }

      return {
        success: true,
        agentId,
        message: `TCP route for agent ${agentId} removed successfully`,
      };
    } catch (err) {
      logger.error(`Failed to remove TCP route: ${err.message}`, {
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
   * Load routes into cache
   *
   * @private
   */
  async _loadRoutesIntoCache() {
    try {
      // Make sure config manager is initialized
      await this.configManager.initialize();

      // Get main configuration
      const mainConfig = this.configManager.configs.main;

      // Clear cache
      this.routeCache.clear();

      // Load HTTP routes
      if (mainConfig.http?.routers) {
        for (const [name, router] of Object.entries(mainConfig.http.routers)) {
          // Skip internal routers
          if (name === "dashboard" || name.startsWith("api@")) {
            continue;
          }

          // Extract agent ID and subdomain from name
          const parts = name.split("-");
          if (parts.length < 2) {
            continue;
          }

          const agentId = parts[0];
          const subdomain = parts.slice(1).join("-");

          // Get service
          const serviceName = router.service;
          const service = mainConfig.http?.services?.[serviceName];

          // Get target URL
          const targetUrl = service?.loadBalancer?.servers?.[0]?.url;

          // Add to cache
          this.routeCache.set(`http:${agentId}:${subdomain}`, {
            name,
            domain: extractDomainFromRule(router.rule),
            targetUrl,
            rule: router.rule,
            service: serviceName,
            lastUpdated: new Date().toISOString(),
          });
        }
      }

      // Load TCP routes
      if (mainConfig.tcp?.routers) {
        for (const [name, router] of Object.entries(mainConfig.tcp.routers)) {
          // Skip catchall router
          if (name === "mongodb-catchall") {
            continue;
          }

          // Extract agent ID from name
          const match = name.match(/^mongodb-(.+)$/);
          if (!match) {
            continue;
          }

          const agentId = match[1];

          // Get service
          const serviceName = router.service;
          const service = mainConfig.tcp?.services?.[serviceName];

          // Get target address
          const targetAddress = service?.loadBalancer?.servers?.[0]?.address;

          // Add to cache
          this.routeCache.set(`tcp:${agentId}`, {
            name,
            domain: extractDomainFromTcpRule(router.rule),
            targetAddress,
            rule: router.rule,
            service: serviceName,
            lastUpdated: new Date().toISOString(),
          });
        }
      }

      logger.info(`Loaded ${this.routeCache.size} routes into cache`);
    } catch (err) {
      logger.error(`Failed to load routes into cache: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
    }
  }

  /**
   * Update configuration
   *
   * @private
   * @param {string} section - The section (http or tcp)
   * @param {string} subsection - The subsection (routers, services, middlewares)
   * @param {string} name - The name of the item
   * @param {Object} config - The configuration
   */
  async _updateConfig(section, subsection, name, config) {
    try {
      // Make sure config manager is initialized
      await this.configManager.initialize();

      // Get main configuration
      const mainConfig = this.configManager.configs.main;

      // Create sections if they don't exist
      if (!mainConfig[section]) {
        mainConfig[section] = {};
      }

      if (!mainConfig[section][subsection]) {
        mainConfig[section][subsection] = {};
      }

      // Update configuration
      mainConfig[section][subsection][name] = config;

      // Save configuration
      await this.configManager.saveConfig("main", mainConfig);
    } catch (err) {
      logger.error(`Failed to update configuration: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      throw err;
    }
  }

  /**
   * Remove configuration
   *
   * @private
   * @param {string} section - The section (http or tcp)
   * @param {string} subsection - The subsection (routers, services, middlewares)
   * @param {string} name - The name of the item
   */
  async _removeConfig(section, subsection, name) {
    try {
      // Make sure config manager is initialized
      await this.configManager.initialize();

      // Get main configuration
      const mainConfig = this.configManager.configs.main;

      // Check if sections exist
      if (
        !mainConfig[section] ||
        !mainConfig[section][subsection] ||
        !mainConfig[section][subsection][name]
      ) {
        logger.warn(
          `Configuration ${section}.${subsection}.${name} does not exist`
        );
        return;
      }

      // Remove configuration
      delete mainConfig[section][subsection][name];

      // Save configuration
      await this.configManager.saveConfig("main", mainConfig);
    } catch (err) {
      logger.error(`Failed to remove configuration: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      throw err;
    }
  }
}

// Helper function to extract domain from rule
function extractDomainFromRule(rule) {
  if (!rule) return null;

  const match = rule.match(/Host\(`([^`]+)`\)/);
  return match ? match[1] : null;
}

// Helper function to extract domain from TCP rule
function extractDomainFromTcpRule(rule) {
  if (!rule) return null;

  const match = rule.match(/HostSNI\(`([^`]+)`\)/);
  return match ? match[1] : null;
}

module.exports = RoutingManager;
