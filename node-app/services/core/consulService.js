/**
 * Consul Service
 *
 * Provides functionality to interact with Consul KV store for managing dynamic
 * configuration for routing and service discovery.
 */

const Consul = require("consul");
const logger = require("../../utils/logger").getLogger("consulService");

class ConsulService {
  constructor() {
    this.host = process.env.CONSUL_HOST || "localhost";
    this.port = process.env.CONSUL_PORT || 8500;
    this.baseUrl = `http://${this.host}:${this.port}/v1`;
    this.prefix = "traefik";
    this.consul = null;
    this.isInitialized = false;
  }

  /**
   * Initialize the Consul service
   * @returns {Promise<boolean>} Success status
   */
  async initialize() {
    try {
      logger.info("Initializing Consul service");

      this.consul = new Consul({
        host: this.host,
        port: this.port,
        promisify: true,
      });

      // Test connection
      await this.consul.kv.get("test");

      // Create base path structure if it doesn't exist
      await this.initializeKeyStructure();

      this.isInitialized = true;
      logger.info("Consul service initialized successfully");
      return true;
    } catch (error) {
      logger.error(`Failed to initialize Consul service: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });
      return false;
    }
  }

  /**
   * Create initial key structure in Consul
   * @returns {Promise<void>}
   */
  async initializeKeyStructure() {
    logger.debug("Initializing Consul key structure");

    // Create base keys with empty structures if they don't exist
    const baseKeys = [
      { key: `${this.prefix}/http/routers`, value: JSON.stringify({}) },
      { key: `${this.prefix}/http/services`, value: JSON.stringify({}) },
      { key: `${this.prefix}/tcp/routers`, value: JSON.stringify({}) },
      { key: `${this.prefix}/tcp/services`, value: JSON.stringify({}) },
      { key: `${this.prefix}/http/middlewares`, value: JSON.stringify({}) },
      { key: `${this.prefix}/tls/certificates`, value: JSON.stringify({}) },
    ];

    for (const { key, value } of baseKeys) {
      try {
        const exists = await this.consul.kv.get(key);
        if (!exists) {
          await this.consul.kv.set(key, value);
          logger.debug(`Created base key: ${key}`);
        }
      } catch (error) {
        logger.warn(`Failed to initialize key ${key}: ${error.message}`);
      }
    }

    // Also create an empty entrypoints configuration
    try {
      const entrypointsKey = `${this.prefix}/entrypoints`;
      const exists = await this.consul.kv.get(entrypointsKey);
      if (!exists) {
        await this.consul.kv.set(
          entrypointsKey,
          JSON.stringify({
            web: { address: ":80" },
            websecure: { address: ":443" },
            mongodb: { address: ":27017" },
          })
        );
        logger.debug(`Created entrypoints key`);
      }
    } catch (error) {
      logger.warn(`Failed to initialize entrypoints key: ${error.message}`);
    }
  }

  /**
   * Recursively sets individual keys in Consul KV from a nested object.
   * @param {string} basePath - The base key path (e.g., 'traefik/tcp/routers/myrouter')
   * @param {object} obj - The configuration object to flatten into KV pairs.
   * @returns {Promise<void>}
   * @private
   */
  async _setConsulKeysFromObject(basePath, obj) {
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const value = obj[key];
        const fullKey = `${basePath}/${key}`;

        if (Array.isArray(value)) {
          // Handle arrays: create indexed keys (e.g., /entrypoints/0, /entrypoints/1)
          for (let i = 0; i < value.length; i++) {
            const indexedKey = `${fullKey}/${i}`;
            const itemValue = value[i];
            if (typeof itemValue === "object" && itemValue !== null) {
              await this._setConsulKeysFromObject(indexedKey, itemValue);
            } else {
              await this.consul.kv.set(indexedKey, String(itemValue));
              logger.debug(`Set array key: ${indexedKey}`);
            }
          }
        } else if (typeof value === "object" && value !== null) {
          // Handle nested objects: recurse
          await this._setConsulKeysFromObject(fullKey, value);
        } else if (value !== null && value !== undefined) {
          // Handle primitive values: set directly
          await this.consul.kv.set(fullKey, String(value));
          logger.debug(`Set key: ${fullKey}`);
        }
      }
    }
  }

  /**
   * Set a key-value pair in Consul - DEPRECATED for complex objects,
   * use _setConsulKeysFromObject for Traefik configs.
   * Kept for simple values or direct use if needed.
   *
   * @param {string} key - The key to set (relative to prefix)
   * @param {any} value - The value to set
   * @returns {Promise<boolean>} Success status
   */
  async set(key, value) {
    try {
      if (!this.isInitialized) {
        throw new Error("Consul service not initialized");
      }
      const fullKey = `${this.prefix}/${key}`;
      const valueStr =
        typeof value === "object" ? JSON.stringify(value) : String(value);

      await this.consul.kv.set(fullKey, valueStr);
      logger.debug(`Set key (legacy): ${fullKey}`);
      return true;
    } catch (error) {
      logger.error(`Failed to set key (legacy) ${key}: ${error.message}`);
      return false;
    }
  }

  /**
   * Get a value from Consul
   * @param {string} key                  - The key or prefix to get (relative to prefix)
   * @param {{ recurse?: boolean }} opts  - If recurse=true, list all children under that prefix
   * @returns {Promise<any>} The value or an object map when recurse=true
   */
  async get(key, { recurse = false } = {}) {
    try {
      if (!this.isInitialized) {
        throw new Error("Consul service not initialized");
      }

      const fullKey = `${this.prefix}/${key}`;

      if (recurse) {
        // return a map of child-key → parsed JSON/value
        const items = await this.consul.kv.get({ key: fullKey, recurse: true });
        if (!items) return {};
        return items.reduce((acc, { Key, Value }) => {
          // strip off the prefix + slash
          const name = Key.slice(fullKey.length + 1);
          let v;
          try {
            v = JSON.parse(Value);
          } catch {
            v = Value;
          }
          acc[name] = v;
          return acc;
        }, {});
      } else {
        // single-key read
        const pair = await this.consul.kv.get(fullKey);
        if (!pair) return null;
        try {
          return JSON.parse(pair.Value);
        } catch {
          return pair.Value;
        }
      }
    } catch (error) {
      logger.error(`Failed to get key ${key}: ${error.message}`);
      return null;
    }
  }

  /**
   * Delete a key or hierarchy from Consul
   * @param {string} key - The key to delete (relative to prefix)
   * @returns {Promise<boolean>} Success status
   */
  async delete(key) {
    try {
      if (!this.isInitialized) {
        throw new Error("Consul service not initialized");
      }

      const fullKey = `${this.prefix}/${key}`;
      // Use recurse: true to delete the hierarchy under the key
      await this.consul.kv.del({ key: fullKey, recurse: true });
      logger.debug(`Deleted key/hierarchy: ${fullKey}`);
      return true;
    } catch (error) {
      logger.error(`Failed to delete key ${key}: ${error.message}`);
      return false;
    }
  }

  /**
   * Add HTTP router configuration to Consul
   * @param {string} name - Router name
   * @param {object} routerConfig - Router configuration
   * @returns {Promise<boolean>} Success status
   */
  async addHttpRouter(name, routerConfig) {
    // TODO: Update this similarly if HTTP routes use Consul KV
    // For now, keep the old method if it works for HTTP
    logger.warn("Using legacy set for addHttpRouter. Consider updating.");
    return this.set(`http/routers/${name}`, routerConfig);
  }

  /**
   * Add HTTP service configuration to Consul
   * @param {string} name - Service name
   * @param {object} serviceConfig - Service configuration
   * @returns {Promise<boolean>} Success status
   */
  async addHttpService(name, serviceConfig) {
    // TODO: Update this similarly if HTTP routes use Consul KV
    // For now, keep the old method if it works for HTTP
    logger.warn("Using legacy set for addHttpService. Consider updating.");
    return this.set(`http/services/${name}`, serviceConfig);
  }

  /**
   * Add TCP router configuration to Consul using individual keys.
   * @param {string} name - Router name
   * @param {object} routerConfig - Router configuration
   * @returns {Promise<boolean>} Success status
   */
  async addTcpRouter(name, routerConfig) {
    try {
      if (!this.isInitialized) {
        throw new Error("Consul service not initialized");
      }
      const basePath = `${this.prefix}/tcp/routers/${name}`;
      await this._setConsulKeysFromObject(basePath, routerConfig);
      return true;
    } catch (error) {
      logger.error(
        `Failed to set TCP router keys for ${name}: ${error.message}`
      );
      return false;
    }
  }

  /**
   * Add TCP service configuration to Consul using individual keys.
   * @param {string} name - Service name
   * @param {object} serviceConfig - Service configuration
   * @returns {Promise<boolean>} Success status
   */
  async addTcpService(name, serviceConfig) {
    try {
      if (!this.isInitialized) {
        throw new Error("Consul service not initialized");
      }
      const basePath = `${this.prefix}/tcp/services/${name}`;
      await this._setConsulKeysFromObject(basePath, serviceConfig);
      return true;
    } catch (error) {
      logger.error(
        `Failed to set TCP service keys for ${name}: ${error.message}`
      );
      return false;
    }
  }

  /**
   * Remove HTTP router configuration from Consul
   * @param {string} name - Router name
   * @returns {Promise<boolean>} Success status
   */
  async removeHttpRouter(name) {
    return this.delete(`http/routers/${name}`);
  }

  /**
   * Remove HTTP service configuration from Consul
   * @param {string} name - Service name
   * @returns {Promise<boolean>} Success status
   */
  async removeHttpService(name) {
    return this.delete(`http/services/${name}`);
  }

  /**
   * Remove TCP router configuration from Consul
   * @param {string} name - Router name
   * @returns {Promise<boolean>} Success status
   */
  async removeTcpRouter(name) {
    return this.delete(`tcp/routers/${name}`);
  }

  /**
   * Remove TCP service configuration from Consul
   * @param {string} name - Service name
   * @returns {Promise<boolean>} Success status
   */
  async removeTcpService(name) {
    return this.delete(`tcp/services/${name}`);
  }

  /**
   * Register a new MongoDB agent with HTTP and TCP routes
   * @param {object} agent - Agent configuration
   * @returns {Promise<boolean>} Success status
   */
  async registerAgent(agent) {
    try {
      if (!this.isInitialized) {
        throw new Error("Consul service not initialized");
      }

      const {
        name,
        subdomain,
        hostname,
        httpPort,
        mongoPort,
        secure = true,
      } = agent;

      if (!name || !subdomain || !hostname || !httpPort || !mongoPort) {
        throw new Error("Missing required agent properties");
      }

      // Create HTTP router
      const httpRouter = {
        entryPoints: ["websecure"],
        rule: `Host(\`${subdomain}.${
          process.env.APP_DOMAIN || "cloudlunacy.uk"
        }\`)`,
        service: `${name}-http`,
        tls: secure ? { certResolver: "letsencrypt" } : null,
      };

      // Create HTTP service
      const httpService = {
        loadBalancer: {
          servers: [{ url: `http://${hostname}:${httpPort}` }],
        },
      };

      // Create MongoDB TCP router
      const tcpRouter = {
        entryPoints: ["mongodb"],
        rule: `HostSNI(\`${subdomain}.${
          process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk"
        }\`)`,
        service: `${name}-mongo`,
        tls: secure
          ? {
              passthrough: true,
            }
          : null,
      };

      // Create MongoDB TCP service
      const tcpService = {
        loadBalancer: {
          servers: [{ address: `${hostname}:${mongoPort}` }],
        },
      };

      // Add configurations to Consul
      await this.addHttpRouter(name, httpRouter);
      await this.addHttpService(`${name}-http`, httpService);
      await this.addTcpRouter(name, tcpRouter);
      await this.addTcpService(`${name}-mongo`, tcpService);

      logger.info(`Registered agent '${name}' in Consul KV store`);
      return true;
    } catch (error) {
      logger.error(`Failed to register agent: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });
      return false;
    }
  }

  /**
   * Unregister an agent from Consul
   * @param {string} name - Agent name
   * @returns {Promise<boolean>} Success status
   */
  async unregisterAgent(name) {
    try {
      if (!this.isInitialized) {
        throw new Error("Consul service not initialized");
      }

      await this.removeHttpRouter(name);
      await this.removeHttpService(`${name}-http`);
      await this.removeTcpRouter(name);
      await this.removeTcpService(`${name}-mongo`);

      logger.info(`Unregistered agent '${name}' from Consul KV store`);
      return true;
    } catch (error) {
      logger.error(`Failed to unregister agent: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });
      return false;
    }
  }
}

module.exports = ConsulService;
