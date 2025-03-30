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

    // Health check interval (5 minutes)
    this.healthCheckInterval = null;
    this.healthCheckIntervalMs = 5 * 60 * 1000;
    this.healthStatus = {
      lastCheck: null,
      status: "unknown",
      details: {},
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

      // Start periodic health checks
      this._startHealthChecks();

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
      const response = await client.get("/info");

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
      const backendsResponse = await client.get("/configuration/backends");
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
   * Clean up stale transactions
   * @returns {Promise<boolean>} Success status
   */
  async _cleanupStaleTransactions() {
    try {
      const client = this._getApiClient();

      // Get all active transactions
      const response = await client.get("/services/haproxy/transactions");
      const transactions = response.data.data;

      if (!transactions || transactions.length === 0) {
        return true;
      }

      // Check for stale transactions (older than 10 minutes)
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

      for (const transaction of transactions) {
        if (transaction.created_at < tenMinutesAgo) {
          logger.warn(
            `Cleaning up stale transaction ${transaction.id} from ${transaction.created_at}`
          );
          await client.delete(
            `/services/haproxy/transactions/${transaction.id}`
          );
        }
      }

      return true;
    } catch (err) {
      logger.error(`Failed to clean up stale transactions: ${err.message}`);
      return false;
    }
  }

  /**
   * Backup current HAProxy configuration
   * @returns {Promise<string>} Backup file path
   */
  async _backupConfiguration() {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupDir = "/var/lib/haproxy/backups";
      const backupFileName = `haproxy_config_${timestamp}.cfg`;
      const backupPath = `${backupDir}/${backupFileName}`;

      // Create backup directory if it doesn't exist
      await execAsync(
        `docker exec ${this.haproxyContainer} mkdir -p ${backupDir}`
      );

      // Copy current config to backup
      await execAsync(
        `docker exec ${this.haproxyContainer} cp /usr/local/etc/haproxy/haproxy.cfg ${backupPath}`
      );

      logger.info(`HAProxy configuration backed up to ${backupPath}`);

      // Prune old backups (keep only the last 10)
      await execAsync(
        `docker exec ${this.haproxyContainer} sh -c 'cd ${backupDir} && ls -t | tail -n +11 | xargs -r rm'`
      );

      return backupPath;
    } catch (err) {
      logger.error(`Failed to backup HAProxy configuration: ${err.message}`);
      // Don't throw, as this is a non-critical operation
      return null;
    }
  }

  /**
   * Start a new transaction
   * @returns {Promise<string>} Transaction ID
   */
  async _startTransaction() {
    try {
      // First cleanup any stale transactions
      await this._cleanupStaleTransactions();

      // Backup current configuration before making changes
      await this._backupConfiguration();

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
      return true;
    }

    try {
      const client = this._getApiClient();
      await client.delete(
        `/services/haproxy/transactions/${this.currentTransaction}`
      );
      logger.info(`Aborted transaction ${this.currentTransaction}`);
      this.currentTransaction = null;
      return true;
    } catch (err) {
      logger.error(`Failed to abort transaction: ${err.message}`, {
        transaction: this.currentTransaction,
        error: err.message,
      });

      // Force reset the transaction ID even if the API call fails
      // This prevents getting stuck with a stale transaction reference
      this.currentTransaction = null;
      return false;
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

  /**
   * Start periodic health checks
   * @private
   */
  _startHealthChecks() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    logger.info(
      `Starting periodic HAProxy health checks every ${
        this.healthCheckIntervalMs / 1000
      } seconds`
    );
    this.healthCheckInterval = setInterval(async () => {
      try {
        await this.performHealthCheck();
      } catch (err) {
        logger.error(`Error during HAProxy health check: ${err.message}`);
      }
    }, this.healthCheckIntervalMs);

    // Run an initial health check
    setTimeout(async () => {
      try {
        await this.performHealthCheck();
      } catch (err) {
        logger.error(
          `Error during initial HAProxy health check: ${err.message}`
        );
      }
    }, 5000);
  }

  /**
   * Perform a health check on HAProxy
   * @returns {Promise<Object>} Health check results
   */
  async performHealthCheck() {
    logger.debug("Performing HAProxy health check");
    const startTime = Date.now();
    const health = {
      timestamp: new Date().toISOString(),
      apiConnected: false,
      containerRunning: false,
      responseTime: 0,
      version: null,
      processes: {
        running: 0,
        total: 0,
      },
      connections: {
        current: 0,
        total: 0,
        max: 0,
      },
      errors: [],
    };

    try {
      // 1. Check if container is running
      try {
        const containerRunning = await this._verifyHAProxyRunning();
        health.containerRunning = containerRunning;
      } catch (err) {
        health.containerRunning = false;
        health.errors.push(`Container check failed: ${err.message}`);
      }

      // 2. Test API connection
      try {
        const client = this._getApiClient();
        const response = await client.get("/info");

        if (response.status === 200) {
          health.apiConnected = true;
          health.version = response.data.version || "unknown";

          // Get process info if available
          if (response.data.processes) {
            health.processes.running = response.data.processes.running || 0;
            health.processes.total = response.data.processes.total || 0;
          }
        }
      } catch (err) {
        health.apiConnected = false;
        health.errors.push(`API connection failed: ${err.message}`);
      }

      // 3. Get connection stats
      try {
        const { stdout } = await execAsync(
          `docker exec ${this.haproxyContainer} sh -c "echo 'show info' | socat unix-connect:/var/run/haproxy.sock stdio" | grep -E 'CurrConns|CumConns|Maxconn'`
        );

        const connLines = stdout.split("\n");
        for (const line of connLines) {
          if (line.includes("CurrConns:")) {
            health.connections.current = parseInt(
              line.split(":")[1].trim(),
              10
            );
          } else if (line.includes("CumConns:")) {
            health.connections.total = parseInt(line.split(":")[1].trim(), 10);
          } else if (line.includes("Maxconn:")) {
            health.connections.max = parseInt(line.split(":")[1].trim(), 10);
          }
        }
      } catch (err) {
        health.errors.push(`Connection stats check failed: ${err.message}`);
      }

      // Calculate response time
      health.responseTime = Date.now() - startTime;

      // Update health status
      this.healthStatus = {
        lastCheck: health.timestamp,
        status:
          health.apiConnected && health.containerRunning
            ? "healthy"
            : "unhealthy",
        details: health,
      };

      // Log health status
      if (health.apiConnected && health.containerRunning) {
        logger.info(
          `HAProxy health check successful. Response time: ${health.responseTime}ms`
        );
      } else {
        logger.warn(
          `HAProxy health check detected issues: ${health.errors.join(", ")}`
        );

        // Send alerts if configured (placeholder for future implementation)
        // this._sendHealthAlert(health);
      }

      return health;
    } catch (err) {
      logger.error(`HAProxy health check failed: ${err.message}`);
      this.healthStatus = {
        lastCheck: new Date().toISOString(),
        status: "unhealthy",
        details: { error: err.message },
      };
      throw err;
    }
  }

  /**
   * Get HAProxy health status
   * @returns {Object} Current health status
   */
  getHealthStatus() {
    return { ...this.healthStatus };
  }

  /**
   * Get HAProxy stats for monitoring
   * @returns {Promise<Object>} Statistics data
   */
  async getStats() {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      const stats = {
        timestamp: new Date().toISOString(),
        frontends: [],
        backends: [],
        servers: [],
        summary: {
          connections: {
            current: 0,
            total: 0,
            rate: 0,
          },
          requests: {
            total: 0,
            rate: 0,
          },
          bytesIn: 0,
          bytesOut: 0,
        },
      };

      // Get stats using Data Plane API
      try {
        const client = this._getApiClient();
        const response = await client.get("/services/haproxy/stats");

        if (response.status === 200 && response.data) {
          if (Array.isArray(response.data.data)) {
            // Process and normalize stats
            for (const item of response.data.data) {
              // Store by type
              if (item.type === "frontend") {
                stats.frontends.push(item);
                // Add to summary
                stats.summary.connections.current += parseInt(
                  item.scur || 0,
                  10
                );
                stats.summary.connections.total += parseInt(item.stot || 0, 10);
                stats.summary.connections.rate += parseInt(item.rate || 0, 10);
                stats.summary.bytesIn += parseInt(item.bin || 0, 10);
                stats.summary.bytesOut += parseInt(item.bout || 0, 10);
              } else if (item.type === "backend") {
                stats.backends.push(item);
                // Sum up request counts
                stats.summary.requests.total += parseInt(item.req_tot || 0, 10);
                stats.summary.requests.rate += parseInt(item.req_rate || 0, 10);
              } else if (item.type === "server") {
                stats.servers.push(item);
              }
            }
          }
        }
      } catch (err) {
        logger.error(`Failed to fetch HAProxy stats via API: ${err.message}`);
        // Fall back to socket command
        const statsData = await this._getStatsFromSocket();
        if (statsData) {
          stats.rawStats = statsData;
        }
      }

      // Get health status
      stats.health = this.getHealthStatus();

      return stats;
    } catch (err) {
      logger.error(`Failed to get HAProxy stats: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get stats directly from HAProxy socket (fallback method)
   * @private
   * @returns {Promise<string>} Raw stats data
   */
  async _getStatsFromSocket() {
    try {
      const { stdout } = await execAsync(
        `docker exec ${this.haproxyContainer} sh -c "echo 'show stat' | socat unix-connect:/var/run/haproxy.sock stdio"`
      );
      return stdout;
    } catch (err) {
      logger.error(`Failed to get stats from socket: ${err.message}`);
      return null;
    }
  }
}

module.exports = HAProxyService;
