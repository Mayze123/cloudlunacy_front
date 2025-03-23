/**
 * Routing Manager
 *
 * Manages HTTP and TCP routes in HAProxy configuration.
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

      // Generate backend name
      const backendName = `${agentId}-${subdomain}-backend`;

      // Generate domain
      const domain = `${subdomain}.${this.appDomain}`;

      // Create HAProxy configuration for this route
      const config = await this.configManager.getConfig("haproxy");

      // Ensure ACL exists for the domain in frontend https-in
      if (!config.frontends || !config.frontends["https-in"]) {
        throw new Error("HAProxy configuration is missing https-in frontend");
      }

      const frontend = config.frontends["https-in"];

      // Add or update ACL for this domain
      const aclName = `host-${agentId}-${subdomain}`;
      frontend.acls = frontend.acls || [];

      // Remove existing ACL if present
      frontend.acls = frontend.acls.filter((acl) => acl.name !== aclName);

      // Add new ACL
      frontend.acls.push({
        name: aclName,
        condition: `host_hdr -i ${domain}`,
      });

      // Add use_backend rule
      frontend.useBackends = frontend.useBackends || [];

      // Remove existing rule if present
      frontend.useBackends = frontend.useBackends.filter(
        (ub) => ub.backend !== backendName
      );

      // Add new rule
      frontend.useBackends.push({
        backend: backendName,
        condition: `if ${aclName}`,
      });

      // Create backend configuration
      config.backends = config.backends || {};
      config.backends[backendName] = {
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

      // Save configuration
      await this.configManager.saveConfig("haproxy", config);

      // Update cache
      this.routeCache.set(`http:${agentId}:${subdomain}`, {
        name: backendName,
        domain,
        targetUrl,
        aclName,
        lastUpdated: new Date().toISOString(),
      });

      // Reload HAProxy to apply changes
      await this._reloadHAProxy();

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
      // Generate backend name and ACL name
      const backendName = `${agentId}-${subdomain}-backend`;
      const aclName = `host-${agentId}-${subdomain}`;

      // Get HAProxy configuration
      const config = await this.configManager.getConfig("haproxy");

      // Remove ACL from frontend https-in
      if (config.frontends && config.frontends["https-in"]) {
        const frontend = config.frontends["https-in"];

        // Remove ACL
        if (frontend.acls) {
          frontend.acls = frontend.acls.filter((acl) => acl.name !== aclName);
        }

        // Remove use_backend rule
        if (frontend.useBackends) {
          frontend.useBackends = frontend.useBackends.filter(
            (ub) => ub.backend !== backendName
          );
        }
      }

      // Remove backend
      if (config.backends && config.backends[backendName]) {
        delete config.backends[backendName];
      }

      // Save configuration
      await this.configManager.saveConfig("haproxy", config);

      // Remove from cache
      this.routeCache.delete(`http:${agentId}:${subdomain}`);

      // Reload HAProxy to apply changes
      await this._reloadHAProxy();

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
   * Add TCP route for MongoDB
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

      // Generate server name
      const serverName = `mongodb-${agentId}`;

      // Update HAProxy configuration to add this MongoDB backend
      const config = await this.configManager.getConfig("haproxy");

      // Ensure mongodb-backend-dyn exists
      if (!config.backends || !config.backends["mongodb-backend-dyn"]) {
        throw new Error(
          "HAProxy configuration is missing mongodb-backend-dyn backend"
        );
      }

      // Update the backend server for this agent
      const backend = config.backends["mongodb-backend-dyn"];

      // Replace or add the server for this agent
      backend.servers = backend.servers || [];

      // Remove existing server for this agent if any
      backend.servers = backend.servers.filter(
        (server) => !server.name.startsWith(`mongodb-${agentId}`)
      );

      // Add the new server
      backend.servers.push({
        name: serverName,
        address: targetAddress,
        check: true,
        ssl: options.useTls !== false,
        sni: `${agentId}.${this.mongoDomain}`,
      });

      // Save configuration
      await this.configManager.saveConfig("haproxy", config);

      // Update cache
      this.routeCache.set(`tcp:${agentId}`, {
        name: serverName,
        domain,
        targetAddress,
        lastUpdated: new Date().toISOString(),
      });

      // Reload HAProxy to apply changes
      await this._reloadHAProxy();

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
      }

      // Get server name (variable used later for logging)
      const _serverName = `mongodb-${agentId}`;

      // Update HAProxy configuration to remove this server
      const config = await this.configManager.getConfig("haproxy");

      // Check if backend exists
      if (!config.backends || !config.backends["mongodb-backend-dyn"]) {
        return {
          success: true,
          message: `No TCP routes found for agent ${agentId}`,
          noActionRequired: true,
        };
      }

      // Get the backend
      const backend = config.backends["mongodb-backend-dyn"];

      // Remove server for this agent if it exists
      if (backend.servers) {
        const initialLength = backend.servers.length;
        backend.servers = backend.servers.filter(
          (server) => !server.name.startsWith(`mongodb-${agentId}`)
        );

        // If no servers were removed, no action required
        if (initialLength === backend.servers.length) {
          return {
            success: true,
            message: `No TCP server found for agent ${agentId}`,
            noActionRequired: true,
          };
        }
      } else {
        return {
          success: true,
          message: "No TCP servers defined for backend",
          noActionRequired: true,
        };
      }

      // Save configuration
      await this.configManager.saveConfig("haproxy", config);

      // Remove from cache if it exists
      if (this.routeCache.has(cacheKey)) {
        this.routeCache.delete(cacheKey);
      }

      // Reload HAProxy to apply changes
      await this._reloadHAProxy();

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

      // Get HAProxy configuration
      const config = await this.configManager.getConfig("haproxy");

      // Clear cache
      this.routeCache.clear();

      // Load HTTP routes from backends
      if (config.backends) {
        for (const [backendName, backend] of Object.entries(config.backends)) {
          // Skip non-agent backends
          if (!backendName.includes("-backend")) {
            continue;
          }

          // Extract agent ID and subdomain from name
          const parts = backendName.split("-");
          if (parts.length < 3 || parts[parts.length - 1] !== "backend") {
            continue;
          }

          const agentId = parts[0];
          const subdomain = parts.slice(1, parts.length - 1).join("-");

          // Skip if not a valid agent backend
          if (!agentId || !subdomain) {
            continue;
          }

          // Get target URL from server
          const server = backend.servers?.[0];
          if (!server) continue;

          // Add to cache
          this.routeCache.set(`http:${agentId}:${subdomain}`, {
            name: backendName,
            domain: `${subdomain}.${this.appDomain}`,
            targetUrl: server.url,
            aclName: `host-${agentId}-${subdomain}`,
            lastUpdated: new Date().toISOString(),
          });
        }
      }

      // Load TCP routes from mongodb-backend-dyn
      if (config.backends?.["mongodb-backend-dyn"]?.servers) {
        const servers = config.backends["mongodb-backend-dyn"].servers;

        for (const server of servers) {
          // Extract agent ID from server name
          const match = server.name.match(/^mongodb-(.+)$/);
          if (!match) {
            continue;
          }

          const agentId = match[1];

          // Add to cache
          this.routeCache.set(`tcp:${agentId}`, {
            name: server.name,
            domain: `${agentId}.${this.mongoDomain}`,
            targetAddress: server.address,
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
   * @param {string} section - The section (frontends, backends, etc.)
   * @param {string} subsection - The subsection name
   * @param {string} name - The name of the item
   * @param {Object} config - The configuration
   */
  async _updateConfig(section, subsection, name, config) {
    try {
      // Make sure config manager is initialized
      await this.configManager.initialize();

      // Get HAProxy configuration
      const haproxyConfig = await this.configManager.getConfig("haproxy");

      // Create sections if they don't exist
      if (!haproxyConfig[section]) {
        haproxyConfig[section] = {};
      }

      if (!haproxyConfig[section][subsection]) {
        haproxyConfig[section][subsection] = {};
      }

      // Update configuration
      haproxyConfig[section][subsection][name] = config;

      // Save configuration
      await this.configManager.saveConfig("haproxy", haproxyConfig);
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
   * @param {string} section - The section (frontends, backends, etc.)
   * @param {string} subsection - The subsection name
   * @param {string} name - The name of the item
   */
  async _removeConfig(section, subsection, name) {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // Get current configuration
      const config = await this.configManager.getConfig("haproxy");

      // Check if section exists
      if (!config[section]) {
        logger.warn(`Section ${section} does not exist in configuration`);
        return false;
      }

      // Check if subsection exists
      if (!config[section][subsection]) {
        logger.warn(
          `Subsection ${subsection} does not exist in section ${section}`
        );
        return false;
      }

      // Check if entry exists
      if (!config[section][subsection][name]) {
        logger.warn(`Entry ${name} does not exist in ${section}.${subsection}`);
        return false;
      }

      // Remove entry
      delete config[section][subsection][name];

      // Save configuration
      await this.configManager.saveConfig("haproxy", config);

      logger.info(
        `Removed ${section}.${subsection}.${name} from configuration`
      );
      return true;
    } catch (err) {
      logger.error(`Failed to remove configuration: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return false;
    }
  }

  /**
   * Reload HAProxy to apply configuration changes
   *
   * @private
   * @returns {Promise<boolean>} Success or failure
   */
  async _reloadHAProxy() {
    try {
      logger.info("Reloading HAProxy...");

      // Get HAProxy container name
      const haproxyContainer = process.env.HAPROXY_CONTAINER || "haproxy";

      // Send reload signal to HAProxy
      const { stdout } = await execAsync(
        `docker kill --signal=USR2 ${haproxyContainer}`
      );

      logger.info(`HAProxy configuration reloaded: ${stdout}`);
      return true;
    } catch (err) {
      logger.error(`Failed to reload HAProxy: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });

      // Try a full restart as fallback
      try {
        const haproxyContainer = process.env.HAPROXY_CONTAINER || "haproxy";
        await execAsync(`docker restart ${haproxyContainer}`);
        logger.info("HAProxy restarted with docker restart command");
        return true;
      } catch (restartErr) {
        logger.error(
          `Failed to restart HAProxy container: ${restartErr.message}`
        );
        return false;
      }
    }
  }
}

// These helper functions are used internally by the class
// They are prefixed with underscore to indicate they are private utility functions
function _extractDomainFromRule(rule) {
  if (!rule) return null;

  const match = rule.match(/host_hdr -i ([^\s]+)/);
  return match ? match[1] : null;
}

// Helper function to extract domain from TCP SNI
function _extractDomainFromTcpRule(sni) {
  return sni || null;
}

module.exports = RoutingManager;
