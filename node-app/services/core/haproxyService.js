/**
 * HAProxy Service
 *
 * A service for managing HAProxy using the Data Plane API, including:
 * - Configuration management
 * - HTTP and TCP route management
 * - MongoDB and Redis server management
 */

const axios = require("axios");
const logger = require("../../utils/logger").getLogger("haproxyService");
const { AppError } = require("../../utils/errorHandler");
const pathManager = require("../../utils/pathManager");
const { execAsync } = require("../../utils/exec");
const { withRetry } = require("../../utils/retryHandler");

class HAProxyService {
  constructor(certificateService) {
    this.initialized = false;
    this._initializing = false;
    this.certificateService = certificateService;

    // Data Plane API configuration
    this.apiBaseUrl = process.env.HAPROXY_API_URL || "http://haproxy:5555/v3";
    this.apiUsername = process.env.HAPROXY_API_USER || "admin";
    this.apiPassword = process.env.HAPROXY_API_PASS || "admin";

    // Domain configuration
    this.appDomain = process.env.APP_DOMAIN || "apps.cloudlunacy.uk";
    this.mongoDomain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
    this.redisDomain = process.env.REDIS_DOMAIN || "redis.cloudlunacy.uk";

    // Container information
    this.haproxyContainer = process.env.HAPROXY_CONTAINER || "haproxy";

    // Route caching
    this.routeCache = new Map();
    this.mongoDBServers = [];

    // Transaction ID for atomic changes
    this.currentTransaction = null;

    // Retry configuration
    this.retry = {
      maxAttempts: 3,
      delay: 1000, // ms
    };
  }

  /**
   * Initialize the HAProxy service
   */
  async initialize() {
    // Prevent re-initialization and circular dependencies
    if (this.initialized || this._initializing) {
      return this.initialized;
    }

    this._initializing = true;
    logger.info("Initializing HAProxy service with Data Plane API");

    try {
      // Initialize path manager if needed
      if (!pathManager.initialized) {
        await pathManager.initialize();
      }

      // Verify HAProxy is running
      await this._verifyHAProxyRunning();

      // Test API connection
      await this._testApiConnection();

      // Load existing configuration to extract routes
      await this._loadConfiguration();

      this.initialized = true;
      this._initializing = false;
      logger.info("HAProxy service initialized successfully");
      return true;
    } catch (err) {
      this._initializing = false;
      logger.error(`Failed to initialize HAProxy service: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return false;
    }
  }

  /**
   * Create axios instance with auth for Data Plane API
   * @returns {Object} Configured axios instance
   */
  _getApiClient() {
    return axios.create({
      baseURL: this.apiBaseUrl,
      auth: {
        username: this.apiUsername,
        password: this.apiPassword,
      },
      timeout: 15000, // Increased timeout for production load
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  /**
   * Test the connection to HAProxy Data Plane API
   * @returns {Promise<boolean>} Connection test result
   */
  async _testApiConnection() {
    try {
      const client = this._getApiClient();
      const response = await client.get("/services/haproxy/info");

      if (response.status === 200) {
        logger.info("Successfully connected to HAProxy Data Plane API");
        logger.debug(`HAProxy version: ${response.data.version}`);
        return true;
      }

      return false;
    } catch (err) {
      logger.error(
        `Failed to connect to HAProxy Data Plane API: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
        }
      );
      return false;
    }
  }

  /**
   * Verify HAProxy is running
   */
  async _verifyHAProxyRunning() {
    try {
      const { stdout } = await execAsync(
        `docker ps -q -f name=${this.haproxyContainer}`
      );

      if (!stdout.trim()) {
        throw new Error(
          `HAProxy container '${this.haproxyContainer}' is not running`
        );
      }

      logger.info(`HAProxy container is running with ID: ${stdout.trim()}`);
      return true;
    } catch (err) {
      logger.error(`Failed to verify HAProxy is running: ${err.message}`);
      throw err;
    }
  }

  /**
   * Load current configuration from HAProxy to populate route cache
   */
  async _loadConfiguration() {
    try {
      const client = this._getApiClient();

      // Clear existing cache
      this.routeCache.clear();
      this.mongoDBServers = [];

      // Load backends to find HTTP routes
      const backendsResponse = await client.get(
        "/services/haproxy/configuration/backends"
      );
      const backends = backendsResponse.data.data;

      // Extract HTTP routes
      for (const backend of backends) {
        // Skip system backends
        if (
          backend.name === "node-app-backend" ||
          backend.name === "mongodb_default"
        ) {
          continue;
        }

        // Parse backend name to extract info (format: agentId-subdomain-backend)
        const nameMatch = backend.name.match(/^([\w-]+)-([\w-]+)-backend$/);
        if (nameMatch) {
          const [, agentId, subdomain] = nameMatch;
          const domain = `${subdomain}.${this.appDomain}`;

          // Extract target URL from server
          let targetUrl = "";
          if (backend.servers && backend.servers.length > 0) {
            targetUrl = backend.servers[0].address;
            if (backend.servers[0].port) {
              targetUrl += `:${backend.servers[0].port}`;
            }
          }

          // Add to route cache
          this.routeCache.set(`http:${agentId}:${subdomain}`, {
            name: backend.name,
            domain,
            targetUrl,
            lastUpdated: new Date().toISOString(),
          });

          logger.debug(`Found HTTP route: ${backend.name} for ${domain}`);
        }
      }

      // Load MongoDB backend to find MongoDB routes
      try {
        const mongoBackendResponse = await client.get(
          "/services/haproxy/configuration/backends/mongodb_default"
        );
        const mongoBackend = mongoBackendResponse.data.data;

        if (mongoBackend && mongoBackend.servers) {
          for (const server of mongoBackend.servers) {
            // Parse server name to extract agent ID (format: mongodb-agent-XXXX)
            const agentIdMatch = server.name.match(/mongodb-agent-([\w-]+)/);
            const agentId = agentIdMatch ? agentIdMatch[1] : null;

            if (agentId) {
              // Add to MongoDB servers list
              this.mongoDBServers.push({
                name: server.name,
                agentId,
                address: server.address,
                port: parseInt(server.port, 10),
                lastUpdated: new Date().toISOString(),
              });

              // Add to route cache
              this.routeCache.set(`mongo:${agentId}`, {
                name: server.name,
                agentId,
                targetHost: server.address,
                targetPort: parseInt(server.port, 10),
                lastUpdated: new Date().toISOString(),
              });

              logger.debug(
                `Found MongoDB server: ${server.name} (${server.address}:${server.port})`
              );
            }
          }
        }
      } catch (err) {
        logger.warn(
          `MongoDB backend not found, creating a new one: ${err.message}`
        );
      }

      logger.info(
        `Loaded ${this.routeCache.size} routes and ${this.mongoDBServers.length} MongoDB servers from HAProxy configuration`
      );
      return true;
    } catch (err) {
      logger.error(`Failed to load HAProxy configuration: ${err.message}`);
      throw err;
    }
  }

  /**
   * Start a transaction for atomic changes
   * @returns {string} Transaction ID
   */
  async _startTransaction() {
    try {
      const client = this._getApiClient();
      const response = await client.post("/services/haproxy/transactions");
      this.currentTransaction = response.data.data.id;
      logger.debug(`Started transaction: ${this.currentTransaction}`);
      return this.currentTransaction;
    } catch (err) {
      logger.error(`Failed to start transaction: ${err.message}`);
      throw err;
    }
  }

  /**
   * Commit the current transaction
   */
  async _commitTransaction(transaction) {
    if (!transaction) {
      logger.warn("No active transaction to commit");
      return;
    }

    try {
      const client = this._getApiClient();
      await client.put(`/services/haproxy/transactions/${transaction}`);
      logger.debug(`Committed transaction: ${transaction}`);
      this.currentTransaction = null;
    } catch (err) {
      logger.error(`Failed to commit transaction: ${err.message}`);
      throw err;
    }
  }

  /**
   * Abort the current transaction
   */
  async _abortTransaction() {
    if (!this.currentTransaction) {
      logger.warn("No active transaction to abort");
      return;
    }

    try {
      const client = this._getApiClient();
      await client.delete(
        `/services/haproxy/transactions/${this.currentTransaction}`
      );
      logger.debug(`Aborted transaction: ${this.currentTransaction}`);
      this.currentTransaction = null;
    } catch (err) {
      logger.error(`Failed to abort transaction: ${err.message}`);
      // Don't throw here as this is typically called in error handling paths
    }
  }

  /**
   * Add HTTP route
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
          await this._startTransaction();

          // Normalize target URL
          if (
            !targetUrl.startsWith("http://") &&
            !targetUrl.startsWith("https://")
          ) {
            targetUrl = `${options.protocol || "http"}://${targetUrl}`;
          }

          // Generate backend name and domain
          const backendName = `${agentId}-${subdomain}-backend`;
          const domain = `${subdomain}.${this.appDomain}`;
          const serverName = `${agentId}-${subdomain}-server`;

          // Parse the target URL to get host and port
          const urlObj = new URL(targetUrl);
          const targetHost = urlObj.hostname;
          const targetPort =
            urlObj.port || (urlObj.protocol === "https:" ? "443" : "80");

          // Check if backend exists
          const client = this._getApiClient();
          try {
            await client.get(
              `/services/haproxy/configuration/backends/${backendName}?transaction_id=${this.currentTransaction}`
            );
            // If it exists, delete it to recreate it
            await client.delete(
              `/services/haproxy/configuration/backends/${backendName}?transaction_id=${this.currentTransaction}`
            );
            logger.debug(`Deleted existing backend: ${backendName}`);
          } catch (err) {
            if (err.response && err.response.status !== 404) {
              throw err;
            }
            // 404 is expected if backend doesn't exist yet
          }

          // Create backend
          const backendData = {
            name: backendName,
            mode: "http",
            balance: { algorithm: "roundrobin" },
            httpchk: { method: "HEAD", uri: "/" },
          };

          await client.post(
            `/services/haproxy/configuration/backends?transaction_id=${this.currentTransaction}`,
            backendData
          );

          // Add server to backend
          const serverData = {
            name: serverName,
            address: targetHost,
            port: parseInt(targetPort, 10),
            check: options.check !== false ? "enabled" : "disabled",
            ssl: options.useTls !== false ? "enabled" : "disabled",
            maxconn: 100,
          };

          await client.post(
            `/services/haproxy/configuration/servers?backend=${backendName}&transaction_id=${this.currentTransaction}`,
            serverData
          );

          // Add binding rule to frontend
          const bindingRule = {
            name: `host-${agentId}-${subdomain}`,
            cond: "if",
            cond_test: `{ hdr(host) -i ${domain} }`,
            type: "use_backend",
            backend: backendName,
          };

          await client.post(
            `/services/haproxy/configuration/http_request_rules?parent_name=https-in&parent_type=frontend&transaction_id=${this.currentTransaction}`,
            bindingRule
          );

          // Commit transaction
          await this._commitTransaction(this.currentTransaction);

          // Update cache
          this.routeCache.set(`http:${agentId}:${subdomain}`, {
            name: backendName,
            domain,
            targetUrl,
            aclName: `host-${agentId}-${subdomain}`,
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
          // Abort transaction if an error occurred
          await this._abortTransaction();

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
   * Add MongoDB route for an agent
   * @param {string} agentId - Agent ID
   * @param {string} targetHost - Target host
   * @param {number} targetPort - Target port
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Result
   */
  async addMongoDBRoute(agentId, targetHost, targetPort = 27017, options = {}) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info(
        `Adding MongoDB route for ${agentId}.${this.mongoDomain} to ${targetHost}:${targetPort}`
      );

      // Validate input
      if (!agentId) {
        throw new AppError("Agent ID is required", 400);
      }

      if (!targetHost) {
        throw new AppError("Target host is required", 400);
      }

      // Handle TLS/SSL if enabled
      if (options.useTls !== false) {
        // Generate or update certificate for this agent if certificate service is available
        if (this.certificateService) {
          try {
            const certResult =
              await this.certificateService.createCertificateForAgent(
                agentId,
                targetHost
              );

            if (!certResult.success) {
              logger.warn(
                `Failed to create certificate for agent ${agentId}: ${certResult.error}`
              );
              // Continue without TLS if certificate generation fails
              options.useTls = false;
            } else {
              logger.info(`Created certificate for agent ${agentId}`);
              options.sslCertPath = certResult.pemPath;
            }
          } catch (certErr) {
            logger.warn(`Error generating certificate: ${certErr.message}`);
            // Continue without TLS if certificate generation fails
            options.useTls = false;
          }
        } else {
          logger.warn(
            "Certificate service not available, proceeding without TLS"
          );
          options.useTls = false;
        }
      }

      // Start transaction
      const transaction = await this._startTransaction();

      try {
        // Create MongoDB backend name
        const backendName = `${agentId}-mongodb-backend`;

        // Create or update backend
        await this._createOrUpdateMongoBackend(
          transaction,
          backendName,
          targetHost,
          targetPort,
          options
        );

        // Add or update frontend ACL and use_backend rule
        await this._setupMongoFrontend(transaction, agentId, backendName);

        // Commit the transaction
        await this._commitTransaction(transaction);

        // Update the cache
        this.routeCache.set(`mongodb:${agentId}`, {
          name: backendName,
          domain: `${agentId}.${this.mongoDomain}`,
          targetHost,
          targetPort,
          lastUpdated: new Date().toISOString(),
        });

        // Add to MongoDB servers list
        const serverExists = this.mongoDBServers.some(
          (server) => server.agentId === agentId
        );
        if (!serverExists) {
          this.mongoDBServers.push({
            agentId,
            host: targetHost,
            port: targetPort,
          });
        }

        return {
          success: true,
          message: `MongoDB route added for ${agentId}.${this.mongoDomain}`,
          domain: `${agentId}.${this.mongoDomain}`,
          useTls: options.useTls !== false,
        };
      } catch (err) {
        // Delete the transaction in case of error
        await this._deleteTransaction(transaction);
        throw err;
      }
    } catch (err) {
      logger.error(`Failed to add MongoDB route: ${err.message}`);
      throw err;
    }
  }

  /**
   * Remove a route (HTTP or MongoDB)
   * @param {string} agentId - The agent ID
   * @param {string} subdomain - The subdomain (for HTTP routes)
   * @param {string} type - The route type (http or mongodb)
   * @returns {Promise<Object>} Result
   */
  async removeRoute(agentId, subdomain, type = "http") {
    if (!this.initialized) {
      await this.initialize();
    }

    // Validate inputs
    if (!agentId) {
      throw new AppError("Agent ID is required", 400);
    }

    if (type === "http" && !subdomain) {
      throw new AppError("Subdomain is required for HTTP routes", 400);
    }

    logger.info(`Removing ${type} route for agent ${agentId}`);

    return withRetry(
      async () => {
        try {
          await this._startTransaction();
          const client = this._getApiClient();

          if (type === "http") {
            // Remove HTTP route
            const cacheKey = `http:${agentId}:${subdomain}`;
            const routeInfo = this.routeCache.get(cacheKey);

            if (!routeInfo) {
              throw new AppError(
                `Route not found: ${agentId}/${subdomain}`,
                404
              );
            }

            // Remove binding rule (HTTP rule)
            const aclName = `host-${agentId}-${subdomain}`;
            try {
              // Find the rule ID first
              const rulesResponse = await client.get(
                `/services/haproxy/configuration/http_request_rules?parent_name=https-in&parent_type=frontend&transaction_id=${this.currentTransaction}`
              );

              const rule = rulesResponse.data.data.find(
                (r) => r.name === aclName
              );
              if (rule) {
                await client.delete(
                  `/services/haproxy/configuration/http_request_rules/${rule.index}?parent_name=https-in&parent_type=frontend&transaction_id=${this.currentTransaction}`
                );
                logger.debug(`Removed HTTP rule: ${aclName}`);
              }
            } catch (err) {
              logger.warn(`Rule not found or error removing: ${err.message}`);
            }

            // Remove backend
            try {
              await client.delete(
                `/services/haproxy/configuration/backends/${routeInfo.name}?transaction_id=${this.currentTransaction}`
              );
              logger.debug(`Removed backend: ${routeInfo.name}`);
            } catch (err) {
              logger.warn(
                `Backend not found or error removing: ${err.message}`
              );
            }

            // Commit changes
            await this._commitTransaction(this.currentTransaction);

            // Remove from cache
            this.routeCache.delete(cacheKey);

            return {
              success: true,
              agentId,
              subdomain,
              type: "http",
              message: "HTTP route removed successfully",
            };
          } else if (type === "mongodb") {
            // Remove MongoDB route
            const cacheKey = `mongo:${agentId}`;
            const routeInfo = this.routeCache.get(cacheKey);

            if (!routeInfo) {
              throw new AppError(`MongoDB route not found: ${agentId}`, 404);
            }

            // Remove server from mongodb_default backend
            try {
              await client.delete(
                `/services/haproxy/configuration/servers/${routeInfo.name}?backend=mongodb_default&transaction_id=${this.currentTransaction}`
              );
              logger.debug(`Removed MongoDB server: ${routeInfo.name}`);
            } catch (err) {
              logger.warn(`Server not found or error removing: ${err.message}`);
            }

            // Remove ACL and binding rule for MongoDB
            try {
              // Find the TCP rule ID first
              const rulesResponse = await client.get(
                `/services/haproxy/configuration/tcp_request_rules?parent_name=tcp-in&parent_type=frontend&transaction_id=${this.currentTransaction}`
              );

              const rule = rulesResponse.data.data.find(
                (r) => r.name === `use-mongo-${agentId}`
              );
              if (rule) {
                await client.delete(
                  `/services/haproxy/configuration/tcp_request_rules/${rule.index}?parent_name=tcp-in&parent_type=frontend&transaction_id=${this.currentTransaction}`
                );
                logger.debug(`Removed TCP rule: use-mongo-${agentId}`);
              }

              // Remove ACL
              await client.delete(
                `/services/haproxy/configuration/acls/host-${agentId}-mongo?parent_name=tcp-in&parent_type=frontend&transaction_id=${this.currentTransaction}`
              );
              logger.debug(`Removed ACL: host-${agentId}-mongo`);
            } catch (err) {
              logger.warn(
                `ACL or rule not found or error removing: ${err.message}`
              );
            }

            // Commit changes
            await this._commitTransaction(this.currentTransaction);

            // Remove from MongoDB servers list
            const serverIndex = this.mongoDBServers.findIndex(
              (server) => server.agentId === agentId
            );

            if (serverIndex !== -1) {
              this.mongoDBServers.splice(serverIndex, 1);
            }

            // Remove from cache
            this.routeCache.delete(cacheKey);

            return {
              success: true,
              agentId,
              type: "mongodb",
              message: "MongoDB route removed successfully",
            };
          } else {
            throw new AppError(`Unsupported route type: ${type}`, 400);
          }
        } catch (err) {
          // Abort transaction if an error occurred
          await this._abortTransaction();

          logger.error(`Error removing ${type} route: ${err.message}`, {
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
          logger.warn(
            `Retry ${attempt} removing ${type} route (${err.message})`
          );
        },
      }
    );
  }

  /**
   * Get all routes for a specific agent
   * @param {string} agentId - The agent ID
   * @returns {Promise<Object>} Routes information
   */
  async getAgentRoutes(agentId) {
    if (!this.initialized) {
      await this.initialize();
    }

    const routes = [];

    for (const [key, value] of this.routeCache.entries()) {
      if (key.includes(`:${agentId}:`)) {
        routes.push({
          ...value,
          type: key.split(":")[0],
        });
      }
    }

    return {
      success: true,
      agentId,
      routes,
    };
  }

  /**
   * Get all routes
   * @returns {Promise<Object>} All routes
   */
  async getAllRoutes() {
    if (!this.initialized) {
      await this.initialize();
    }

    const routes = [];

    for (const [key, value] of this.routeCache.entries()) {
      const [type, agentId] = key.split(":");
      routes.push({
        ...value,
        type,
        agentId,
      });
    }

    return {
      success: true,
      routes,
    };
  }

  /**
   * Check MongoDB port availability
   * @returns {Promise<boolean>} Is MongoDB port available
   */
  async checkMongoDBPort() {
    try {
      // Check if MongoDB port is available through HAProxy Data Plane API
      const client = this._getApiClient();
      const response = await client.get(
        "/services/haproxy/runtime/servers?backend=mongodb_default"
      );

      if (
        !response.data ||
        !response.data.data ||
        response.data.data.length === 0
      ) {
        logger.warn("No MongoDB servers found via Data Plane API");
        return false;
      }

      // Alternative: Check using netstat through the container
      const { stdout } = await execAsync(
        `docker exec ${this.haproxyContainer} netstat -tuln | grep -c :27017 || true`
      );

      const portCount = parseInt(stdout.trim() || "0", 10);
      return portCount > 0;
    } catch (err) {
      logger.error(`Failed to check MongoDB port: ${err.message}`);
      return false;
    }
  }

  /**
   * Ensure MongoDB port is available and configured
   * @returns {Promise<boolean>} Success status
   */
  async ensureMongoDBPort() {
    try {
      await this._startTransaction();
      const client = this._getApiClient();

      // Check if mongodb_default backend exists
      try {
        await client.get(
          `/services/haproxy/configuration/backends/mongodb_default?transaction_id=${this.currentTransaction}`
        );
        logger.info("MongoDB backend exists");
      } catch (err) {
        if (err.response && err.response.status === 404) {
          // Create MongoDB backend
          const backendData = {
            name: "mongodb_default",
            mode: "tcp",
            balance: { algorithm: "roundrobin" },
          };

          await client.post(
            `/services/haproxy/configuration/backends?transaction_id=${this.currentTransaction}`,
            backendData
          );
          logger.info("Created MongoDB backend");
        } else {
          throw err;
        }
      }

      // Check if TCP frontend exists
      try {
        await client.get(
          `/services/haproxy/configuration/frontends/tcp-in?transaction_id=${this.currentTransaction}`
        );
        logger.info("TCP frontend exists");
      } catch (err) {
        if (err.response && err.response.status === 404) {
          // Create TCP frontend
          const frontendData = {
            name: "tcp-in",
            mode: "tcp",
            default_backend: "mongodb_default",
            binds: [
              {
                name: "mongodb",
                address: "*",
                port: 27017,
                ssl: {
                  crt_list: "/etc/ssl/private/mongo-cert.pem",
                },
              },
            ],
          };

          await client.post(
            `/services/haproxy/configuration/frontends?transaction_id=${this.currentTransaction}`,
            frontendData
          );
          logger.info("Created TCP frontend for MongoDB");
        } else {
          throw err;
        }
      }

      // Make sure default rule exists
      try {
        const rules = await client.get(
          `/services/haproxy/configuration/tcp_request_rules?parent_name=tcp-in&parent_type=frontend&transaction_id=${this.currentTransaction}`
        );

        const defaultRule = rules.data.data.find(
          (r) => r.name === "default-mongodb"
        );
        if (!defaultRule) {
          // Add default rule
          const bindingRule = {
            name: "default-mongodb",
            type: "use_backend",
            backend: "mongodb_default",
          };

          await client.post(
            `/services/haproxy/configuration/tcp_request_rules?parent_name=tcp-in&parent_type=frontend&transaction_id=${this.currentTransaction}`,
            bindingRule
          );
          logger.info("Added default MongoDB routing rule");
        }
      } catch (err) {
        if (err.response && err.response.status !== 404) {
          throw err;
        }

        // If 404, no rules exist, add default rule
        const bindingRule = {
          name: "default-mongodb",
          type: "use_backend",
          backend: "mongodb_default",
        };

        await client.post(
          `/services/haproxy/configuration/tcp_request_rules?parent_name=tcp-in&parent_type=frontend&transaction_id=${this.currentTransaction}`,
          bindingRule
        );
        logger.info("Added default MongoDB routing rule");
      }

      // Commit changes
      await this._commitTransaction(this.currentTransaction);

      return true;
    } catch (err) {
      // Abort transaction if an error occurred
      await this._abortTransaction();

      logger.error(`Failed to ensure MongoDB port: ${err.message}`);
      return false;
    }
  }
}

module.exports = HAProxyService;
