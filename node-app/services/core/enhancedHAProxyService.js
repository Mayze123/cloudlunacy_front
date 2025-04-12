/**
 * Enhanced HAProxy Service
 *
 * A unified interface for HAProxy management with
 * - Robust transaction handling
 * - Circuit breaking for failure isolation
 * - Enhanced monitoring and metrics
 * - Automatic recovery capabilities
 * - Progressive deployment of configuration changes
 */

const axios = require("axios");
const path = require("path");
const fs = require("fs").promises;
const logger = require("../../utils/logger").getLogger(
  "enhancedHAProxyService"
);
const { AppError } = require("../../utils/errorHandler");
const { execAsync } = require("../../utils/exec");
const { withRetry } = require("../../utils/retryHandler");
const TransactionManager = require("../../utils/haproxyTransactionManager");
const HAProxyCircuitBreaker = require("../../utils/haproxyCircuitBreaker");
const HAProxyMonitor = require("../../utils/haproxyMonitor");
const HAProxyMetricsManager = require("../../utils/haproxyMetricsManager");
const HAProxyLoadOptimizer = require("../../utils/haproxyLoadOptimizer");

/**
 * Enhanced HAProxy Service providing a unified interface with
 * resilience features like circuit breaker, transaction management,
 * and enhanced monitoring
 */
class EnhancedHAProxyService {
  /**
   * Create a new Enhanced HAProxy Service
   * @param {Object} options - Configuration options
   */
  constructor(options = {}) {
    this.initialized = false;
    this._initializing = false;

    // Configuration
    this.apiBaseUrl = process.env.HAPROXY_API_URL || "http://haproxy:5555/v3";
    this.apiUsername = process.env.HAPROXY_API_USER || "admin";
    this.apiPassword = process.env.HAPROXY_API_PASS || "admin";
    this.haproxyContainer = process.env.HAPROXY_CONTAINER || "haproxy";
    this.appDomain = process.env.APP_DOMAIN || "apps.cloudlunacy.uk";
    this.mongoDomain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";

    // API Client
    this.apiClient = this._createApiClient();

    // Create components
    this.monitor = new HAProxyMonitor({
      apiClient: this.apiClient,
      containerName: this.haproxyContainer,
      checkInterval: options.monitorInterval || 60000, // Default: check every minute
    });

    this.circuitBreaker = new HAProxyCircuitBreaker({
      failureThreshold: 5,
      resetTimeout: 30000,
      healthCheck: async () => {
        const status = await this.monitor.checkHealth();
        return status.status === "HEALTHY";
      },
    });

    this.transactionManager = new TransactionManager(
      this.apiClient,
      this.haproxyContainer
    );

    // Initialize metrics manager
    this.metricsManager = new HAProxyMetricsManager({
      apiClient: this.apiClient,
      collectionInterval: options.metricsInterval || 10000, // Default: collect every 10 seconds
      enableStorage: true,
      enableAnomalyDetection: true,
    });

    // Initialize load optimizer
    this.loadOptimizer = new HAProxyLoadOptimizer({
      apiClient: this.apiClient,
      metricsManager: this.metricsManager,
      optimizationInterval: options.optimizationInterval || 30000, // Default: optimize every 30 seconds
      algorithm: options.loadOptimizationAlgorithm || "adaptive", // Default to adaptive algorithm
      adaptationRate: options.adaptationRate || 0.3, // Default adaptation rate
      enablePredictiveScaling: options.enablePredictiveScaling !== false,
    });

    // Route caching
    this.routeCache = new Map();
    this.mongoDBServers = [];

    // Set up monitoring event handlers
    this._setupEventHandlers();
  }

  /**
   * Initialize the service
   * @returns {Promise<boolean>} Success status
   */
  async initialize() {
    if (this.initialized || this._initializing) {
      return this.initialized;
    }

    this._initializing = true;
    logger.info("Initializing Enhanced HAProxy service");

    try {
      // First check if HAProxy is running
      const isRunning = await this._verifyHAProxyRunning();
      if (!isRunning) {
        logger.warn(
          "HAProxy container is not running, service will operate in limited mode"
        );
      }

      // Load configuration initially using circuit breaker
      try {
        await this.circuitBreaker.execute(
          () => this._loadConfiguration(),
          "Load initial configuration"
        );
      } catch (err) {
        if (err.code === "CIRCUIT_OPEN") {
          logger.warn("Circuit is open, couldn't load initial configuration");
        } else {
          logger.error(`Failed to load initial configuration: ${err.message}`);
        }
      }

      // Initialize metrics manager
      try {
        await this.metricsManager.initialize();
        logger.info("HAProxy metrics manager initialized");
      } catch (err) {
        logger.warn(
          `Failed to initialize metrics manager: ${err.message}. Metrics collection will be limited.`
        );
      }

      // Initialize load optimizer
      try {
        await this.loadOptimizer.initialize();
        logger.info("HAProxy load optimizer initialized");
      } catch (err) {
        logger.warn(
          `Failed to initialize load optimizer: ${err.message}. Load optimization will be disabled.`
        );
      }

      // Start health monitoring
      this.monitor.start();
      this.circuitBreaker.startHealthChecks();

      this.initialized = true;
      this._initializing = false;
      logger.info("Enhanced HAProxy service initialized successfully");
      return true;
    } catch (err) {
      this._initializing = false;
      logger.error(
        `Failed to initialize Enhanced HAProxy service: ${err.message}`
      );
      // Still mark as initialized to allow limited functionality
      this.initialized = true;
      return false;
    }
  }

  /**
   * Set up event handlers for monitoring
   * @private
   */
  _setupEventHandlers() {
    // Monitor events
    this.monitor.onStatusChange(({ previousStatus, currentStatus }) => {
      logger.info(
        `HAProxy status changed from ${previousStatus} to ${currentStatus}`
      );

      // If status restored to healthy, close circuit
      if (currentStatus === "HEALTHY" && previousStatus !== "HEALTHY") {
        if (this.circuitBreaker.getStatus().state !== "CLOSED") {
          logger.info("HAProxy healthy, resetting circuit breaker");
          this.circuitBreaker.reset();
        }
      }
    });

    this.monitor.onAlert((alert) => {
      logger.error(
        `HAProxy ALERT: ${alert.status} after ${alert.failures} failures`
      );
    });

    this.monitor.onRecovery(() => {
      logger.info("HAProxy recovered to healthy state");
    });

    // Circuit breaker events
    this.circuitBreaker.on("open", ({ reason }) => {
      logger.warn(`Circuit breaker opened: ${reason}`);
    });

    this.circuitBreaker.on("half-open", () => {
      logger.info(
        "Circuit breaker in half-open state, testing HAProxy availability"
      );
    });

    this.circuitBreaker.on("close", () => {
      logger.info("Circuit breaker closed, HAProxy operations resumed");
    });
    // Load optimizer events
    this.loadOptimizer.on("optimization-complete", (event) => {
      logger.info(
        `Load optimization completed with ${event.changes} changes using ${event.algorithm} algorithm`
      );
    });

    this.loadOptimizer.on("optimization-failed", (event) => {
      logger.warn(`Load optimization failed: ${event.error}`);
    });

    // Load optimizer events
    this.loadOptimizer.on("optimization-complete", (event) => {
      logger.info(
        `Load optimization completed with ${event.changes} changes using ${event.algorithm} algorithm`
      );
    });

    this.loadOptimizer.on("optimization-failed", (event) => {
      logger.warn(`Load optimization failed: ${event.error}`);
    });
  }

  /**
   * Create API client for HAProxy Data Plane API
   * @returns {Object} Axios instance
   * @private
   */
  _createApiClient() {
    return axios.create({
      baseURL: this.apiBaseUrl,
      auth: {
        username: this.apiUsername,
        password: this.apiPassword,
      },
      timeout: 15000,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  /**
   * Verify HAProxy is running
   * @returns {Promise<boolean>} Is HAProxy running
   * @private
   */
  async _verifyHAProxyRunning() {
    try {
      const { stdout } = await execAsync(
        `docker ps -q -f name=${this.haproxyContainer}`
      );
      return !!stdout.trim();
    } catch (err) {
      logger.error(`Failed to verify if HAProxy is running: ${err.message}`);
      return false;
    }
  }

  /**
   * Load current configuration from HAProxy
   * @returns {Promise<boolean>} Success status
   * @private
   */
  async _loadConfiguration() {
    try {
      logger.info("Loading HAProxy configuration");

      // Clear existing caches
      this.routeCache.clear();
      this.mongoDBServers = [];

      // Load backends to find HTTP routes
      const backendsResponse = await this.apiClient.get(
        "/configuration/backends"
      );
      const backends = backendsResponse.data.data || [];

      // Process HTTP backends
      let httpRoutes = 0;
      for (const backend of backends) {
        // Skip system backends
        if (
          backend.name === "node-app-backend" ||
          backend.name === "mongodb_default"
        ) {
          continue;
        }

        // Parse backend name (format: agentId-subdomain-backend)
        const nameMatch = backend.name.match(/^([\w-]+)-([\w-]+)-backend$/);
        if (nameMatch) {
          const [, agentId, subdomain] = nameMatch;
          const domain = `${subdomain}.${this.appDomain}`;

          // Extract target URL
          let targetUrl = "";
          if (backend.servers && backend.servers.length > 0) {
            const server = backend.servers[0];
            targetUrl = server.address;
            if (server.port) {
              targetUrl += `:${server.port}`;
            }
            // Add protocol if not present
            if (targetUrl && !targetUrl.startsWith("http")) {
              targetUrl = `http://${targetUrl}`;
            }
          }

          // Add to route cache
          this.routeCache.set(`http:${agentId}:${subdomain}`, {
            name: backend.name,
            domain,
            targetUrl,
            lastUpdated: new Date().toISOString(),
          });
          httpRoutes++;
        }
      }

      // Load MongoDB routes
      try {
        const mongoBackendResponse = await this.apiClient.get(
          "/services/haproxy/configuration/backends/mongodb_default"
        );
        const mongoBackend = mongoBackendResponse.data.data;

        if (mongoBackend && mongoBackend.servers) {
          for (const server of mongoBackend.servers) {
            // Parse server name (format: mongodb-agent-XXXX)
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
            }
          }
        }
      } catch (err) {
        logger.warn(`Failed to load MongoDB routes: ${err.message}`);
      }

      logger.info(
        `Loaded ${this.routeCache.size} routes (${httpRoutes} HTTP routes, ${this.mongoDBServers.length} MongoDB servers)`
      );
      return true;
    } catch (err) {
      logger.error(`Failed to load HAProxy configuration: ${err.message}`);
      throw err;
    }
  }

  /**
   * Add HTTP route to HAProxy
   * @param {string} agentId - Agent ID
   * @param {string} subdomain - Subdomain
   * @param {string} targetUrl - Target URL
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

    // Execute operation with circuit breaker
    try {
      // Use circuit breaker with retry handler
      return await this.circuitBreaker.execute(async () => {
        return await withRetry(
          async () => {
            return await this.transactionManager.withTransaction(
              `add_http_route_${agentId}_${subdomain}`,
              async (transaction) => {
                // Normalize target URL
                if (
                  !targetUrl.startsWith("http://") &&
                  !targetUrl.startsWith("https://")
                ) {
                  targetUrl = `${options.protocol || "http"}://${targetUrl}`;
                }

                // Parse URL
                const urlObj = new URL(targetUrl);
                const targetHost = urlObj.hostname;
                const targetPort =
                  urlObj.port || (urlObj.protocol === "https:" ? "443" : "80");

                // Generate names
                const backendName = `${agentId}-${subdomain}-backend`;
                const domain = `${subdomain}.${this.appDomain}`;
                const serverName = `${agentId}-${subdomain}-server`;

                // Backend may already exist, try to delete it first
                try {
                  await this.apiClient.delete(
                    `/services/haproxy/configuration/backends/${backendName}?transaction_id=${transaction.id}`
                  );
                  logger.debug(`Deleted existing backend: ${backendName}`);
                } catch (err) {
                  // Ignore 404 errors (backend doesn't exist yet)
                  if (!err.response || err.response.status !== 404) {
                    throw err;
                  }
                }

                // Create backend
                await this.apiClient.post(
                  `/services/haproxy/configuration/backends?transaction_id=${transaction.id}`,
                  {
                    name: backendName,
                    mode: "http",
                    balance: { algorithm: "roundrobin" },
                    httpchk: { method: "HEAD", uri: "/" },
                  }
                );

                // Add server to backend
                await this.apiClient.post(
                  `/services/haproxy/configuration/servers?backend=${backendName}&transaction_id=${transaction.id}`,
                  {
                    name: serverName,
                    address: targetHost,
                    port: parseInt(targetPort, 10),
                    check: options.check !== false ? "enabled" : "disabled",
                    ssl: options.useTls !== false ? "enabled" : "disabled",
                    maxconn: options.maxconn || 100,
                  }
                );

                // Add binding rule to frontend
                await this.apiClient.post(
                  `/services/haproxy/configuration/http_request_rules?parent_name=https-in&parent_type=frontend&transaction_id=${transaction.id}`,
                  {
                    name: `host-${agentId}-${subdomain}`,
                    cond: "if",
                    cond_test: `{ hdr(host) -i ${domain} }`,
                    type: "use_backend",
                    backend: backendName,
                  }
                );

                // Update route cache
                this.routeCache.set(`http:${agentId}:${subdomain}`, {
                  name: backendName,
                  domain,
                  targetUrl,
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
              },
              {
                // Transaction options
                validateBeforeCommit: true,
                checkAfterCommit: true,
              }
            );
          },
          {
            // Retry options
            maxRetries: 3,
            initialDelay: 1000,
            onRetry: (err, attempt) => {
              logger.warn(`Retry ${attempt} adding HTTP route: ${err.message}`);
            },
          }
        );
      }, `Add HTTP Route: ${subdomain}.${this.appDomain}`);
    } catch (err) {
      if (err.code === "CIRCUIT_OPEN") {
        throw new AppError(
          "HAProxy service is currently unavailable. Please try again later.",
          503
        );
      }
      throw err;
    }
  }

  /**
   * Add MongoDB route to HAProxy
   * @param {string} agentId - Agent ID
   * @param {string} targetHost - Target host
   * @param {number} targetPort - Target port
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Result
   */
  async addMongoDBRoute(agentId, targetHost, targetPort = 27017, options = {}) {
    if (!this.initialized) {
      await this.initialize();
    }

    // Validate inputs
    if (!agentId) {
      throw new AppError("Agent ID is required", 400);
    }
    if (!targetHost) {
      throw new AppError("Target host is required", 400);
    }

    logger.info(
      `Adding MongoDB route for ${agentId}.${this.mongoDomain} to ${targetHost}:${targetPort}`
    );

    // Execute operation with circuit breaker
    try {
      return await this.circuitBreaker.execute(async () => {
        return await this.transactionManager.withTransaction(
          `add_mongodb_route_${agentId}`,
          async (transaction) => {
            // Create MongoDB backend name
            const backendName = `${agentId}-mongodb-backend`;
            const serverName = `mongodb-agent-${agentId}`;

            // Check if backend exists
            let backendExists = false;
            try {
              await this.apiClient.get(
                `/services/haproxy/configuration/backends/${backendName}?transaction_id=${transaction.id}`
              );
              backendExists = true;
            } catch (err) {
              if (err.response && err.response.status === 404) {
                backendExists = false;
              } else {
                throw err;
              }
            }

            // Create or update backend
            if (backendExists) {
              await this.apiClient.put(
                `/services/haproxy/configuration/backends/${backendName}?transaction_id=${transaction.id}`,
                {
                  mode: "tcp",
                  balance: { algorithm: "roundrobin" },
                }
              );
            } else {
              await this.apiClient.post(
                `/services/haproxy/configuration/backends?transaction_id=${transaction.id}`,
                {
                  name: backendName,
                  mode: "tcp",
                  balance: { algorithm: "roundrobin" },
                }
              );
            }

            // Check if server exists in the backend
            let serverExists = false;
            try {
              await this.apiClient.get(
                `/services/haproxy/configuration/servers/${serverName}?backend=${backendName}&transaction_id=${transaction.id}`
              );
              serverExists = true;
            } catch (err) {
              if (err.response && err.response.status === 404) {
                serverExists = false;
              } else {
                throw err;
              }
            }

            // Create or update server
            const serverData = {
              name: serverName,
              address: targetHost,
              port: parseInt(targetPort, 10),
              check: options.check !== false ? "enabled" : "disabled",
            };

            if (serverExists) {
              await this.apiClient.put(
                `/services/haproxy/configuration/servers/${serverName}?backend=${backendName}&transaction_id=${transaction.id}`,
                serverData
              );
            } else {
              await this.apiClient.post(
                `/services/haproxy/configuration/servers?backend=${backendName}&transaction_id=${transaction.id}`,
                serverData
              );
            }

            // Also add server to default MongoDB backend
            const defaultServerName = `mongodb-agent-${agentId}`;
            let defaultServerExists = false;

            try {
              await this.apiClient.get(
                `/services/haproxy/configuration/servers/${defaultServerName}?backend=mongodb_default&transaction_id=${transaction.id}`
              );
              defaultServerExists = true;
            } catch (err) {
              if (err.response && err.response.status === 404) {
                defaultServerExists = false;
              } else {
                throw err;
              }
            }

            // Create or update server in default backend
            if (defaultServerExists) {
              await this.apiClient.put(
                `/services/haproxy/configuration/servers/${defaultServerName}?backend=mongodb_default&transaction_id=${transaction.id}`,
                serverData
              );
            } else {
              await this.apiClient.post(
                `/services/haproxy/configuration/servers?backend=mongodb_default&transaction_id=${transaction.id}`,
                serverData
              );
            }

            // Add route to tcp frontend
            try {
              // Check if we already have a use_backend rule for this agent
              const aclName = `use-mongo-${agentId}`;
              let ruleExists = false;

              try {
                const rules = await this.apiClient.get(
                  `/services/haproxy/configuration/tcp_request_rules?parent_name=tcp-in&parent_type=frontend&transaction_id=${transaction.id}`
                );

                ruleExists = rules.data.data.some(
                  (rule) => rule.name === aclName
                );
              } catch (err) {
                if (!err.response || err.response.status !== 404) {
                  throw err;
                }
              }

              if (!ruleExists) {
                await this.apiClient.post(
                  `/services/haproxy/configuration/tcp_request_rules?parent_name=tcp-in&parent_type=frontend&transaction_id=${transaction.id}`,
                  {
                    name: aclName,
                    type: "use_backend",
                    backend: backendName,
                    cond: "if",
                    cond_test: `{ req_ssl_sni -i ${agentId}.${this.mongoDomain} }`,
                  }
                );
              }
            } catch (err) {
              logger.warn(`Failed to add TCP request rule: ${err.message}`);
              // Continue anyway as the default backend will still work
            }

            // Update cache
            this.routeCache.set(`mongo:${agentId}`, {
              agentId,
              targetHost,
              targetPort,
              domain: `${agentId}.${this.mongoDomain}`,
              lastUpdated: new Date().toISOString(),
            });

            // Update MongoDB servers list
            const serverIndex = this.mongoDBServers.findIndex(
              (server) => server.agentId === agentId
            );

            if (serverIndex !== -1) {
              this.mongoDBServers[serverIndex] = {
                name: serverName,
                agentId,
                address: targetHost,
                port: parseInt(targetPort, 10),
                lastUpdated: new Date().toISOString(),
              };
            } else {
              this.mongoDBServers.push({
                name: serverName,
                agentId,
                address: targetHost,
                port: parseInt(targetPort, 10),
                lastUpdated: new Date().toISOString(),
              });
            }

            return {
              success: true,
              agentId,
              targetHost,
              targetPort,
              domain: `${agentId}.${this.mongoDomain}`,
              type: "mongodb",
            };
          },
          {
            // Transaction options
            validateBeforeCommit: true,
            checkAfterCommit: true,
          }
        );
      }, `Add MongoDB Route: ${agentId}.${this.mongoDomain}`);
    } catch (err) {
      if (err.code === "CIRCUIT_OPEN") {
        throw new AppError(
          "HAProxy service is currently unavailable. Please try again later.",
          503
        );
      }
      throw err;
    }
  }

  /**
   * Remove a route from HAProxy
   * @param {string} agentId - Agent ID
   * @param {string} subdomain - Subdomain (for HTTP routes)
   * @param {string} type - Route type ('http' or 'mongodb')
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

    // Execute operation with circuit breaker
    try {
      return await this.circuitBreaker.execute(async () => {
        if (type === "http") {
          // Remove HTTP route
          const cacheKey = `http:${agentId}:${subdomain}`;
          const routeInfo = this.routeCache.get(cacheKey);

          if (!routeInfo) {
            throw new AppError(
              `HTTP route not found: ${agentId}/${subdomain}`,
              404
            );
          }

          return await this.transactionManager.withTransaction(
            `remove_http_route_${agentId}_${subdomain}`,
            async (transaction) => {
              // Remove backend and associated rules
              const backendName = `${agentId}-${subdomain}-backend`;
              const ruleName = `host-${agentId}-${subdomain}`;

              // Find and remove binding rule
              try {
                const rulesResponse = await this.apiClient.get(
                  `/services/haproxy/configuration/http_request_rules?parent_name=https-in&parent_type=frontend&transaction_id=${transaction.id}`
                );

                const rule = rulesResponse.data.data.find(
                  (r) => r.name === ruleName
                );
                if (rule) {
                  await this.apiClient.delete(
                    `/services/haproxy/configuration/http_request_rules/${rule.index}?parent_name=https-in&parent_type=frontend&transaction_id=${transaction.id}`
                  );
                  logger.debug(`Removed HTTP rule: ${ruleName}`);
                }
              } catch (err) {
                logger.warn(`Error finding/removing HTTP rule: ${err.message}`);
              }

              // Remove backend
              try {
                await this.apiClient.delete(
                  `/services/haproxy/configuration/backends/${backendName}?transaction_id=${transaction.id}`
                );
                logger.debug(`Removed backend: ${backendName}`);
              } catch (err) {
                if (!err.response || err.response.status !== 404) {
                  throw err;
                }
                logger.warn(
                  `Backend ${backendName} not found when trying to remove it`
                );
              }

              // Remove from cache
              this.routeCache.delete(cacheKey);

              return {
                success: true,
                agentId,
                subdomain,
                type: "http",
                message: "HTTP route removed successfully",
              };
            }
          );
        } else if (type === "mongodb") {
          // Remove MongoDB route
          const cacheKey = `mongo:${agentId}`;
          const routeInfo = this.routeCache.get(cacheKey);

          if (!routeInfo) {
            throw new AppError(`MongoDB route not found: ${agentId}`, 404);
          }

          return await this.transactionManager.withTransaction(
            `remove_mongodb_route_${agentId}`,
            async (transaction) => {
              const backendName = `${agentId}-mongodb-backend`;
              const serverName = `mongodb-agent-${agentId}`;
              const ruleName = `use-mongo-${agentId}`;

              // Remove TCP rule if it exists
              try {
                const rulesResponse = await this.apiClient.get(
                  `/services/haproxy/configuration/tcp_request_rules?parent_name=tcp-in&parent_type=frontend&transaction_id=${transaction.id}`
                );

                const rule = rulesResponse.data.data.find(
                  (r) => r.name === ruleName
                );
                if (rule) {
                  await this.apiClient.delete(
                    `/services/haproxy/configuration/tcp_request_rules/${rule.index}?parent_name=tcp-in&parent_type=frontend&transaction_id=${transaction.id}`
                  );
                  logger.debug(`Removed TCP rule: ${ruleName}`);
                }
              } catch (err) {
                logger.warn(`Error finding/removing TCP rule: ${err.message}`);
              }

              // Remove server from default MongoDB backend
              try {
                await this.apiClient.delete(
                  `/services/haproxy/configuration/servers/${serverName}?backend=mongodb_default&transaction_id=${transaction.id}`
                );
                logger.debug(
                  `Removed server ${serverName} from mongodb_default backend`
                );
              } catch (err) {
                if (!err.response || err.response.status !== 404) {
                  logger.warn(
                    `Error removing server from default backend: ${err.message}`
                  );
                }
              }

              // Remove agent-specific MongoDB backend if it exists
              try {
                await this.apiClient.delete(
                  `/services/haproxy/configuration/backends/${backendName}?transaction_id=${transaction.id}`
                );
                logger.debug(`Removed backend: ${backendName}`);
              } catch (err) {
                if (!err.response || err.response.status !== 404) {
                  logger.warn(`Error removing MongoDB backend: ${err.message}`);
                }
              }

              // Update MongoDB servers list
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
            }
          );
        } else {
          throw new AppError(`Unsupported route type: ${type}`, 400);
        }
      }, `Remove ${type} route for ${agentId}`);
    } catch (err) {
      if (err.code === "CIRCUIT_OPEN") {
        throw new AppError(
          "HAProxy service is currently unavailable. Please try again later.",
          503
        );
      }
      throw err;
    }
  }

  /**
   * Get all routes for a specific agent
   * @param {string} agentId - Agent ID
   * @returns {Promise<Object>} Routes
   */
  async getAgentRoutes(agentId) {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!agentId) {
      throw new AppError("Agent ID is required", 400);
    }

    const routes = [];

    for (const [key, value] of this.routeCache.entries()) {
      if (key.includes(`:${agentId}:`)) {
        routes.push({
          ...value,
          type: key.split(":")[0],
        });
      }

      if (key.startsWith("mongo:") && key.endsWith(agentId)) {
        routes.push({
          ...value,
          type: "mongodb",
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
      const parts = key.split(":");
      const type = parts[0];
      const agentId = parts[1];

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
   * Get HAProxy health status with detailed metrics
   * @param {boolean} forceRefresh - Force a fresh health check
   * @returns {Promise<Object>} Health status
   */
  async getHealthStatus(forceRefresh = false) {
    if (!this.initialized) {
      await this.initialize();
    }

    if (forceRefresh) {
      await this.monitor.checkHealth();
    }

    const monitorStatus = this.monitor.getStatus();
    const circuitStatus = this.circuitBreaker.getStatus();

    return {
      timestamp: new Date().toISOString(),
      status: monitorStatus.status,
      circuitState: circuitStatus.state,
      metrics: monitorStatus.metrics,
      lastCheck: monitorStatus.lastCheck,
      routeCount: this.routeCache.size,
      failureCount: monitorStatus.failureCount,
      recoveryAttempts: monitorStatus.recoveryAttemptCount,
      circuitDetails: {
        failureCount: circuitStatus.failureCount,
        failureThreshold: circuitStatus.failureThreshold,
        lastStateChange: new Date(circuitStatus.lastStateChange).toISOString(),
        lastFailure: circuitStatus.lastFailure
          ? {
              time: new Date(circuitStatus.lastFailure.time).toISOString(),
              error: circuitStatus.lastFailure.error,
              operation: circuitStatus.lastFailure.operation,
            }
          : null,
      },
    };
  }

  /**
   * Attempt manual recovery of HAProxy service
   * @returns {Promise<Object>} Recovery result
   */
  async recoverService() {
    if (!this.initialized) {
      await this.initialize();
    }

    logger.info("Attempting manual HAProxy service recovery");

    try {
      // First try to restart the service
      const restartSuccess = await this.monitor.restartService();

      if (restartSuccess) {
        // Reset circuit breaker
        this.circuitBreaker.reset();

        return {
          success: true,
          message: "HAProxy service recovered successfully",
          action: "restart",
        };
      }

      // If restart didn't work, try to start the container
      const { stdout: containerId } = await execAsync(
        `docker ps -q -f name=${this.haproxyContainer}`
      );

      if (!containerId.trim()) {
        await execAsync(`docker start ${this.haproxyContainer}`);

        // Wait a bit for container to start
        await new Promise((resolve) => setTimeout(resolve, 5000));

        // Check if container started
        const { stdout: newContainerId } = await execAsync(
          `docker ps -q -f name=${this.haproxyContainer}`
        );

        if (newContainerId.trim()) {
          // Check service health
          const health = await this.monitor.checkHealth();

          if (health.status === "HEALTHY" || health.status === "DEGRADED") {
            // Reset circuit breaker
            this.circuitBreaker.reset();

            return {
              success: true,
              message: "HAProxy container started successfully",
              action: "container_start",
            };
          }
        }
      }

      return {
        success: false,
        message: "Failed to recover HAProxy service",
      };
    } catch (err) {
      logger.error(`Failed to recover HAProxy service: ${err.message}`);

      return {
        success: false,
        message: `Failed to recover HAProxy service: ${err.message}`,
        error: err.message,
      };
    }
  }

  /**
   * Validate HAProxy configuration
   * @returns {Promise<Object>} Validation result
   */
  async validateConfig() {
    try {
      await execAsync(
        `docker exec ${this.haproxyContainer} haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg`
      );

      return {
        valid: true,
        message: "HAProxy configuration is valid",
      };
    } catch (err) {
      return {
        valid: false,
        message: "HAProxy configuration is invalid",
        error: err.message,
      };
    }
  }

  /**
   * Get detailed HAProxy stats
   * @returns {Promise<Object>} Stats
   */
  async getStats() {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      return await this.circuitBreaker.execute(async () => {
        const response = await this.apiClient.get("/services/haproxy/stats");

        if (response.status !== 200 || !response.data) {
          throw new Error("Failed to fetch HAProxy stats");
        }

        const stats = {
          timestamp: new Date().toISOString(),
          frontends: [],
          backends: [],
          servers: [],
          summary: {
            connections: { current: 0, total: 0, rate: 0 },
            requests: { total: 0, rate: 0 },
            errors: { total: 0 },
            bytes: { in: 0, out: 0 },
          },
        };

        if (Array.isArray(response.data.data)) {
          response.data.data.forEach((item) => {
            if (item.type === "frontend") {
              stats.frontends.push(item);
              stats.summary.connections.current += parseInt(item.scur || 0, 10);
              stats.summary.connections.total += parseInt(item.stot || 0, 10);
              stats.summary.connections.rate += parseInt(item.rate || 0, 10);
              stats.summary.bytes.in += parseInt(item.bin || 0, 10);
              stats.summary.bytes.out += parseInt(item.bout || 0, 10);
            } else if (item.type === "backend") {
              stats.backends.push(item);
              stats.summary.errors.total +=
                parseInt(item.econ || 0, 10) + parseInt(item.eresp || 0, 10);
              stats.summary.requests.total +=
                parseInt(item.hrsp_1xx || 0, 10) +
                parseInt(item.hrsp_2xx || 0, 10) +
                parseInt(item.hrsp_3xx || 0, 10) +
                parseInt(item.hrsp_4xx || 0, 10) +
                parseInt(item.hrsp_5xx || 0, 10);
            } else if (item.type === "server") {
              stats.servers.push(item);
            }
          });
        }

        stats.health = await this.getHealthStatus();

        return stats;
      }, "Get HAProxy Stats");
    } catch (err) {
      if (err.code === "CIRCUIT_OPEN") {
        throw new AppError(
          "HAProxy service is currently unavailable. Please try again later.",
          503
        );
      }

      logger.error(`Failed to get HAProxy stats: ${err.message}`);

      // Return limited stats
      return {
        timestamp: new Date().toISOString(),
        error: err.message,
        health: await this.getHealthStatus(),
      };
    }
  }

  /**
   * Update multiple routes in a single transaction
   * @param {Array<Object>} routeUpdates - Array of route update objects
   * @returns {Promise<Object>} Result
   */
  async updateMultipleRoutes(routeUpdates) {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!Array.isArray(routeUpdates) || routeUpdates.length === 0) {
      throw new AppError("Route updates must be a non-empty array", 400);
    }

    logger.info(
      `Updating ${routeUpdates.length} routes in a single transaction`
    );

    return await this.circuitBreaker.execute(async () => {
      return await this.transactionManager.withTransaction(
        "update_multiple_routes",
        async (transaction) => {
          const results = {
            success: true,
            total: routeUpdates.length,
            successful: 0,
            failed: 0,
            routes: [],
          };

          for (const update of routeUpdates) {
            try {
              // Process based on route type
              if (update.type === "http") {
                // Update HTTP route
                const { agentId, subdomain, targetUrl } = update;

                if (!agentId || !subdomain || !targetUrl) {
                  throw new Error(
                    "Missing required fields for HTTP route update"
                  );
                }

                // Generate names
                const backendName = `${agentId}-${subdomain}-backend`;
                const serverName = `${agentId}-${subdomain}-server`;

                // Parse URL
                const urlObj = new URL(
                  targetUrl.startsWith("http")
                    ? targetUrl
                    : `http://${targetUrl}`
                );
                const targetHost = urlObj.hostname;
                const targetPort =
                  urlObj.port || (urlObj.protocol === "https:" ? "443" : "80");

                // Update the server in the backend
                try {
                  await this.apiClient.put(
                    `/services/haproxy/configuration/servers/${serverName}?backend=${backendName}&transaction_id=${transaction.id}`,
                    {
                      address: targetHost,
                      port: parseInt(targetPort, 10),
                    }
                  );

                  // Update cache
                  this.routeCache.set(`http:${agentId}:${subdomain}`, {
                    ...(this.routeCache.get(`http:${agentId}:${subdomain}`) ||
                      {}),
                    targetUrl,
                    lastUpdated: new Date().toISOString(),
                  });

                  results.successful++;
                  results.routes.push({
                    type: "http",
                    agentId,
                    subdomain,
                    targetUrl,
                    success: true,
                  });
                } catch (err) {
                  results.failed++;
                  results.routes.push({
                    type: "http",
                    agentId,
                    subdomain,
                    success: false,
                    error: err.message,
                  });
                }
              } else if (update.type === "mongodb") {
                // Update MongoDB route
                const { agentId, targetHost, targetPort } = update;

                if (!agentId || !targetHost) {
                  throw new Error(
                    "Missing required fields for MongoDB route update"
                  );
                }

                // Update server in default backend
                const serverName = `mongodb-agent-${agentId}`;
                try {
                  await this.apiClient.put(
                    `/services/haproxy/configuration/servers/${serverName}?backend=mongodb_default&transaction_id=${transaction.id}`,
                    {
                      address: targetHost,
                      port: parseInt(targetPort || 27017, 10),
                    }
                  );

                  // Update agent-specific backend if it exists
                  const backendName = `${agentId}-mongodb-backend`;
                  try {
                    await this.apiClient.get(
                      `/services/haproxy/configuration/backends/${backendName}?transaction_id=${transaction.id}`
                    );

                    // Backend exists, update its server
                    await this.apiClient.put(
                      `/services/haproxy/configuration/servers/${serverName}?backend=${backendName}&transaction_id=${transaction.id}`,
                      {
                        address: targetHost,
                        port: parseInt(targetPort || 27017, 10),
                      }
                    );
                  } catch (err) {
                    // Backend doesn't exist, that's fine
                  }

                  // Update cache and server list
                  this.routeCache.set(`mongo:${agentId}`, {
                    ...(this.routeCache.get(`mongo:${agentId}`) || {}),
                    targetHost,
                    targetPort: parseInt(targetPort || 27017, 10),
                    lastUpdated: new Date().toISOString(),
                  });

                  // Update MongoDB servers list
                  const serverIndex = this.mongoDBServers.findIndex(
                    (server) => server.agentId === agentId
                  );

                  if (serverIndex !== -1) {
                    this.mongoDBServers[serverIndex] = {
                      ...this.mongoDBServers[serverIndex],
                      address: targetHost,
                      port: parseInt(targetPort || 27017, 10),
                      lastUpdated: new Date().toISOString(),
                    };
                  }

                  results.successful++;
                  results.routes.push({
                    type: "mongodb",
                    agentId,
                    targetHost,
                    targetPort: parseInt(targetPort || 27017, 10),
                    success: true,
                  });
                } catch (err) {
                  results.failed++;
                  results.routes.push({
                    type: "mongodb",
                    agentId,
                    success: false,
                    error: err.message,
                  });
                }
              } else {
                results.failed++;
                results.routes.push({
                  type: update.type,
                  success: false,
                  error: `Unsupported route type: ${update.type}`,
                });
              }
            } catch (err) {
              results.failed++;
              results.routes.push({
                ...update,
                success: false,
                error: err.message,
              });
            }
          }

          // Update overall success status
          results.success = results.failed === 0;

          return results;
        },
        {
          validateBeforeCommit: true,
          checkAfterCommit: true,
        }
      );
    }, "Update Multiple Routes");
  }
}

module.exports = EnhancedHAProxyService;
