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
   * Set a key-value pair in Consul
   * @param {string} key - The key to set
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
        typeof value === "object" ? JSON.stringify(value) : value;

      await this.consul.kv.set(fullKey, valueStr);
      logger.debug(`Set key: ${fullKey}`);
      return true;
    } catch (error) {
      logger.error(`Failed to set key ${key}: ${error.message}`);
      return false;
    }
  }

  /**
   * Get a value from Consul
   * @param {string} key - The key to get
   * @returns {Promise<any>} The value
   */
  async get(key) {
    try {
      if (!this.isInitialized) {
        throw new Error("Consul service not initialized");
      }

      const fullKey = `${this.prefix}/${key}`;
      const result = await this.consul.kv.get(fullKey);

      if (!result) {
        return null;
      }

      // Try to parse as JSON, return as is if not valid JSON
      try {
        return JSON.parse(result.Value);
      } catch (e) {
        return result.Value;
      }
    } catch (error) {
      logger.error(`Failed to get key ${key}: ${error.message}`);
      return null;
    }
  }

  /**
   * Delete a key from Consul
   * @param {string} key - The key to delete
   * @returns {Promise<boolean>} Success status
   */
  async delete(key) {
    try {
      if (!this.isInitialized) {
        throw new Error("Consul service not initialized");
      }

      const fullKey = `${this.prefix}/${key}`;
      await this.consul.kv.del(fullKey);
      logger.debug(`Deleted key: ${fullKey}`);
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
    return this.set(`http/routers/${name}`, routerConfig);
  }

  /**
   * Add HTTP service configuration to Consul
   * @param {string} name - Service name
   * @param {object} serviceConfig - Service configuration
   * @returns {Promise<boolean>} Success status
   */
  async addHttpService(name, serviceConfig) {
    return this.set(`http/services/${name}`, serviceConfig);
  }

  /**
   * Add TCP router configuration to Consul
   * @param {string} name - Router name
   * @param {object} routerConfig - Router configuration
   * @returns {Promise<boolean>} Success status
   */
  async addTcpRouter(name, routerConfig) {
    return this.set(`tcp/routers/${name}`, routerConfig);
  }

  /**
   * Add TCP service configuration to Consul
   * @param {string} name - Service name
   * @param {object} serviceConfig - Service configuration
   * @returns {Promise<boolean>} Success status
   */
  async addTcpService(name, serviceConfig) {
    return this.set(`tcp/services/${name}`, serviceConfig);
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
              passthrough: false,
              certResolver: "letsencrypt",
              options: "mongodb",
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
