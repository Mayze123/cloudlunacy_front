/**
 * Intelligent Routing Manager
 *
 * Advanced routing optimization for HAProxy that makes smart decisions based on:
 * - Real-time server performance metrics
 * - Connection latency and geographic distribution
 * - Request characteristics and historical patterns
 * - Resource utilization across backend servers
 */

const EventEmitter = require("events");
const logger = require("./logger").getLogger("intelligentRoutingManager");
const { withRetry } = require("./retryHandler");

class IntelligentRoutingManager extends EventEmitter {
  /**
   * Create a new intelligent routing manager
   * @param {Object} options - Configuration options
   * @param {Object} options.apiClient - HAProxy Data Plane API client
   * @param {Object} options.metricsCollector - HAProxy metrics collector
   * @param {Object} options.monitor - HAProxy monitor instance
   * @param {Number} options.updateInterval - Routing update interval in ms (default: 1min)
   * @param {Boolean} options.enableGeoRouting - Enable geo-based routing (default: false)
   * @param {Boolean} options.enableContentAwareRouting - Enable content-based routing (default: true)
   * @param {Number} options.performanceWeight - Weight for performance in routing decisions (default: 0.7)
   * @param {Number} options.loadWeight - Weight for load balancing in routing decisions (default: 0.3)
   */
  constructor(options = {}) {
    super();

    this.apiClient = options.apiClient;
    this.metricsCollector = options.metricsCollector;
    this.monitor = options.monitor;

    // Routing configuration
    this.updateInterval = options.updateInterval || 60 * 1000; // 1 minute
    this.enableGeoRouting = !!options.enableGeoRouting;
    this.enableContentAwareRouting =
      options.enableContentAwareRouting !== false;

    // Decision weights
    this.performanceWeight = options.performanceWeight || 0.7;
    this.loadWeight = options.loadWeight || 0.3;

    // State tracking
    this.initialized = false;
    this.updateTimer = null;
    this.isUpdating = false;
    this.lastUpdateTime = null;
    this.routingTable = new Map();
    this.acls = new Map();
    this.serverPerformance = new Map();
    this.contentRules = new Map();
    this.geoMapping = new Map();
    this.dynamicWeights = new Map();

    // Historical data for learning
    this.routingHistory = [];
    this.performanceHistory = [];

    // Bind methods
    this.updateRoutingConfiguration =
      this.updateRoutingConfiguration.bind(this);
  }

  /**
   * Initialize the routing manager
   * @returns {Promise<boolean>} Initialization result
   */
  async initialize() {
    if (this.initialized) {
      return true;
    }

    try {
      logger.info("Initializing intelligent routing manager");

      // Check if dependencies are available
      if (!this.apiClient) {
        logger.error("API client is required for intelligent routing");
        return false;
      }

      // Load current HAProxy configuration
      await this.loadCurrentConfiguration();

      // Initialize server performance tracking
      await this.initializePerformanceTracking();

      // Load content rules if content-aware routing is enabled
      if (this.enableContentAwareRouting) {
        await this.loadContentRules();
      }

      // Load geo mapping if geo-based routing is enabled
      if (this.enableGeoRouting) {
        await this.loadGeoMapping();
      }

      // Start periodic routing updates
      this.startRoutingUpdates();

      this.initialized = true;
      logger.info("Intelligent routing manager initialized successfully");
      return true;
    } catch (err) {
      logger.error(
        `Failed to initialize intelligent routing manager: ${err.message}`
      );
      return false;
    }
  }

  /**
   * Load current HAProxy configuration
   * @returns {Promise<void>}
   * @private
   */
  async loadCurrentConfiguration() {
    try {
      logger.info("Loading current HAProxy configuration");

      // Get all backends to understand server groupings
      const backendsResponse = await this.apiClient.get(
        "/services/haproxy/configuration/backends"
      );
      const backends = backendsResponse.data.data;

      // Process each backend
      for (const backend of backends) {
        const backendName = backend.name;

        // Skip special backends
        if (backendName.includes("stats") || backendName.includes("admin")) {
          continue;
        }

        // Get servers for this backend
        if (backend.servers && backend.servers.length > 0) {
          const servers = [];

          for (const server of backend.servers) {
            servers.push({
              name: server.name,
              address: server.address,
              port: server.port,
              weight: parseInt(server.weight || "100", 10),
              maxconn: parseInt(server.maxconn || "0", 10),
              check: server.check === "enabled",
              backup: server.backup === "enabled",
            });

            // Initialize performance metrics for this server
            this.serverPerformance.set(`${backendName}/${server.name}`, {
              responseTime: 0,
              errorRate: 0,
              currentConnections: 0,
              status: "unknown",
              lastUpdated: new Date().toISOString(),
            });
          }

          // Store backend information
          this.routingTable.set(backendName, {
            name: backendName,
            servers,
            balance: backend.balance,
            mode: backend.mode,
            algorithm: backend.balance || "roundrobin",
          });
        }
      }

      // Load existing ACLs for routing decisions
      const aclsResponse = await this.apiClient.get(
        "/services/haproxy/configuration/acls"
      );
      if (aclsResponse.data.data) {
        for (const acl of aclsResponse.data.data) {
          this.acls.set(acl.id, {
            id: acl.id,
            name: acl.name,
            criterion: acl.criterion,
            value: acl.value,
            parent_type: acl.parent_type,
            parent_name: acl.parent_name,
          });
        }
      }

      logger.info(
        `Loaded configuration: ${this.routingTable.size} backends, ${this.acls.size} ACLs`
      );
    } catch (err) {
      logger.error(`Failed to load HAProxy configuration: ${err.message}`);
      throw err;
    }
  }

  /**
   * Initialize performance tracking
   * @returns {Promise<void>}
   * @private
   */
  async initializePerformanceTracking() {
    try {
      // Update current performance metrics if metrics collector is available
      if (this.metricsCollector) {
        const metrics = this.metricsCollector.getCurrentMetrics();
        if (metrics && metrics.haproxy && metrics.haproxy.stats) {
          this.updatePerformanceMetrics(metrics.haproxy.stats);
        }
      }

      logger.info("Performance tracking initialized");
    } catch (err) {
      logger.warn(`Error initializing performance tracking: ${err.message}`);
    }
  }

  /**
   * Load content routing rules
   * @returns {Promise<void>}
   * @private
   */
  async loadContentRules() {
    try {
      // Define content categories with corresponding paths/patterns
      // This would typically be loaded from a configuration file or database
      const defaultRules = [
        {
          name: "static-content",
          pattern: "\\.(?:css|js|jpg|jpeg|png|gif|ico|svg|woff2?|ttf|eot)$",
          targetBackend: "static-backend",
          priority: 100,
        },
        {
          name: "api-requests",
          pattern: "^/api/",
          targetBackend: "api-backend",
          priority: 200,
        },
        {
          name: "admin-requests",
          pattern: "^/admin",
          targetBackend: "admin-backend",
          priority: 300,
        },
      ];

      // Store content rules
      for (const rule of defaultRules) {
        this.contentRules.set(rule.name, rule);
      }

      logger.info(`Loaded ${this.contentRules.size} content routing rules`);
    } catch (err) {
      logger.warn(`Error loading content rules: ${err.message}`);
    }
  }

  /**
   * Load geographic routing mappings
   * @returns {Promise<void>}
   * @private
   */
  async loadGeoMapping() {
    try {
      // Define geographic mappings
      // This would typically be loaded from a configuration file or database
      const defaultMappings = [
        {
          region: "north-america",
          countries: ["US", "CA", "MX"],
          preferredBackend: "na-backend",
          priority: 100,
        },
        {
          region: "europe",
          countries: ["GB", "DE", "FR", "IT", "ES", "NL"],
          preferredBackend: "eu-backend",
          priority: 100,
        },
        {
          region: "asia-pacific",
          countries: ["JP", "CN", "IN", "AU", "SG"],
          preferredBackend: "apac-backend",
          priority: 100,
        },
      ];

      // Store geo mappings
      for (const mapping of defaultMappings) {
        this.geoMapping.set(mapping.region, mapping);
      }

      logger.info(`Loaded ${this.geoMapping.size} geographic routing mappings`);
    } catch (err) {
      logger.warn(`Error loading geo mappings: ${err.message}`);
    }
  }

  /**
   * Update performance metrics from HAProxy stats
   * @param {Array} stats - HAProxy stats
   * @private
   */
  updatePerformanceMetrics(stats) {
    if (!Array.isArray(stats)) return;

    const now = new Date().toISOString();

    // Process server stats
    for (const stat of stats) {
      if (stat.type !== "server") continue;

      const backendName = stat.pxname;
      const serverName = stat.svname;
      const key = `${backendName}/${serverName}`;

      // Skip BACKEND and FRONTEND entries
      if (serverName === "BACKEND" || serverName === "FRONTEND") continue;

      // Get current performance data or initialize
      const performance = this.serverPerformance.get(key) || {
        responseTime: 0,
        errorRate: 0,
        currentConnections: 0,
        status: "unknown",
        lastUpdated: now,
      };

      // Update with latest stats
      performance.status =
        stat.status === "UP"
          ? "up"
          : stat.status === "DOWN"
          ? "down"
          : "unknown";
      performance.currentConnections = parseInt(stat.scur || "0", 10);

      // Calculate response time if available
      if (stat.ttime !== undefined) {
        performance.responseTime = parseInt(stat.ttime || "0", 10);
      }

      // Calculate error rate
      const totalRequests = parseInt(stat.stot || "1", 10); // Avoid division by zero
      const errors =
        parseInt(stat.econ || "0", 10) +
        parseInt(stat.eresp || "0", 10) +
        parseInt(stat.dresp || "0", 10);

      performance.errorRate = (errors / totalRequests) * 100;
      performance.lastUpdated = now;

      // Update server performance
      this.serverPerformance.set(key, performance);
    }

    // Keep history of performance metrics for machine learning
    if (this.metricsCollector) {
      this.performanceHistory.push({
        timestamp: now,
        metrics: [...this.serverPerformance.entries()].map(([key, perf]) => ({
          server: key,
          ...perf,
        })),
      });

      // Keep performance history manageable
      if (this.performanceHistory.length > 100) {
        this.performanceHistory.shift();
      }
    }
  }

  /**
   * Start periodic routing updates
   */
  startRoutingUpdates() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
    }

    logger.info(
      `Starting routing updates with interval of ${this.updateInterval / 1000}s`
    );

    // Schedule regular updates
    this.updateTimer = setInterval(
      this.updateRoutingConfiguration,
      this.updateInterval
    );

    // Run an initial update
    setTimeout(() => {
      this.updateRoutingConfiguration().catch((err) => {
        logger.error(`Initial routing update failed: ${err.message}`);
      });
    }, 5000);
  }

  /**
   * Stop routing updates
   */
  stopRoutingUpdates() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
      logger.info("Routing updates stopped");
    }
  }

  /**
   * Update routing configuration based on current performance metrics
   * @returns {Promise<Object>} Update results
   */
  async updateRoutingConfiguration() {
    if (this.isUpdating) {
      logger.debug("Routing update already in progress, skipping");
      return { success: false, reason: "update_in_progress" };
    }

    this.isUpdating = true;

    try {
      logger.info("Updating routing configuration");

      // Get latest metrics
      if (this.metricsCollector) {
        const metrics = this.metricsCollector.getCurrentMetrics();
        if (metrics && metrics.haproxy && metrics.haproxy.stats) {
          this.updatePerformanceMetrics(metrics.haproxy.stats);
        }
      }

      // Calculate optimal server weights based on performance
      const weights = await this.calculateOptimalWeights();

      // Apply weight changes in a transaction
      const changes = await this.applyServerWeights(weights);

      // Update content-based routing if enabled
      let contentChanges = [];
      if (this.enableContentAwareRouting) {
        contentChanges = await this.updateContentRouting();
      }

      // Update geo-based routing if enabled
      let geoChanges = [];
      if (this.enableGeoRouting) {
        geoChanges = await this.updateGeoRouting();
      }

      this.lastUpdateTime = new Date();

      // Track routing update history
      this.routingHistory.push({
        timestamp: this.lastUpdateTime.toISOString(),
        weightChanges: changes,
        contentChanges,
        geoChanges,
      });

      // Keep routing history manageable
      if (this.routingHistory.length > 50) {
        this.routingHistory.shift();
      }

      // Emit event for routing update
      this.emit("routing-updated", {
        timestamp: this.lastUpdateTime.toISOString(),
        changes: [...changes, ...contentChanges, ...geoChanges],
      });

      logger.info(
        `Routing updated with ${changes.length} weight changes, ${contentChanges.length} content rules, ${geoChanges.length} geo rules`
      );

      return {
        success: true,
        timestamp: this.lastUpdateTime.toISOString(),
        changes: {
          weights: changes.length,
          content: contentChanges.length,
          geo: geoChanges.length,
        },
      };
    } catch (err) {
      logger.error(`Failed to update routing configuration: ${err.message}`);

      // Emit event for routing update failure
      this.emit("routing-update-failed", {
        timestamp: new Date().toISOString(),
        error: err.message,
      });

      return {
        success: false,
        error: err.message,
      };
    } finally {
      this.isUpdating = false;
    }
  }

  /**
   * Calculate optimal server weights based on performance
   * @returns {Promise<Map>} Map of server keys to weights
   * @private
   */
  async calculateOptimalWeights() {
    const weights = new Map();

    try {
      // Group servers by backend
      const backendServers = new Map();

      for (const [key, performance] of this.serverPerformance.entries()) {
        const [backend, server] = key.split("/");

        if (!backendServers.has(backend)) {
          backendServers.set(backend, []);
        }

        backendServers.get(backend).push({
          key,
          server,
          performance,
        });
      }

      // Calculate optimal weights for each backend
      for (const [backend, servers] of backendServers.entries()) {
        // Skip if only one server (no weight adjustment needed)
        if (servers.length <= 1) continue;

        // Skip servers that are down
        const activeServers = servers.filter(
          (s) => s.performance.status === "up"
        );
        if (activeServers.length === 0) continue;

        // Calculate performance score for each active server
        const serverScores = activeServers.map((s) => {
          // Performance score factors:
          // 1. Response time (lower is better)
          // 2. Error rate (lower is better)
          // 3. Current connections (lower is better for balancing)

          const responseTimeScore =
            s.performance.responseTime > 0
              ? 100 / (1 + Math.log10(1 + s.performance.responseTime))
              : 100;

          const errorRateScore = 100 - Math.min(100, s.performance.errorRate);

          // Combine scores with weights
          const performanceScore =
            responseTimeScore * 0.6 + errorRateScore * 0.4;

          return {
            ...s,
            responseTimeScore,
            errorRateScore,
            performanceScore,
            // Final score considers both performance and current load
            finalScore:
              performanceScore * this.performanceWeight +
              (100 / (1 + s.performance.currentConnections)) * this.loadWeight,
          };
        });

        // Calculate total score
        const totalScore = serverScores.reduce(
          (sum, s) => sum + s.finalScore,
          0
        );

        if (totalScore === 0) continue;

        // Calculate optimal weights proportional to scores
        const backendInfo = this.routingTable.get(backend);
        const baselineWeight = backendInfo?.servers?.[0]?.weight || 100;

        for (const server of serverScores) {
          // Convert score to weight (min 1, max 256)
          const rawWeight = Math.max(
            1,
            Math.round(
              (server.finalScore / totalScore) *
                backendInfo.servers.length *
                baselineWeight
            )
          );
          const optimalWeight = Math.min(256, rawWeight);

          // Get current weight from routing table
          const currentWeight =
            backendInfo.servers.find((s) => s.name === server.server)?.weight ||
            100;

          // Only update if weight changed significantly (avoid unnecessary changes)
          if (Math.abs(currentWeight - optimalWeight) >= 5) {
            weights.set(server.key, {
              backend,
              server: server.server,
              currentWeight,
              optimalWeight,
            });
          }
        }
      }
    } catch (err) {
      logger.error(`Failed to calculate optimal weights: ${err.message}`);
    }

    return weights;
  }

  /**
   * Apply calculated server weights to HAProxy configuration
   * @param {Map} weights - Map of server keys to weight objects
   * @returns {Promise<Array>} List of changes made
   * @private
   */
  async applyServerWeights(weights) {
    const changes = [];

    if (weights.size === 0) {
      return changes;
    }

    try {
      logger.info(`Applying weight changes to ${weights.size} servers`);

      // Start a transaction for all changes
      const transaction = await this.startTransaction();

      try {
        for (const [key, weight] of weights.entries()) {
          const { backend, server, currentWeight, optimalWeight } = weight;

          try {
            // Get current server to preserve all other settings
            const serverResponse = await this.apiClient.get(
              `/services/haproxy/configuration/servers/${server}?backend=${backend}&transaction_id=${transaction}`
            );

            const serverConfig = serverResponse.data.data;

            // Update weight
            serverConfig.weight = optimalWeight;

            // Apply update
            await this.apiClient.put(
              `/services/haproxy/configuration/servers/${server}?backend=${backend}&transaction_id=${transaction}`,
              serverConfig
            );

            // Track the change
            changes.push({
              type: "weight",
              backend,
              server,
              oldWeight: currentWeight,
              newWeight: optimalWeight,
            });

            // Update routing table
            const backendInfo = this.routingTable.get(backend);
            if (backendInfo) {
              const serverInfo = backendInfo.servers.find(
                (s) => s.name === server
              );
              if (serverInfo) {
                serverInfo.weight = optimalWeight;
              }
            }

            // Store in dynamic weights for tracking
            this.dynamicWeights.set(key, {
              backend,
              server,
              weight: optimalWeight,
              lastUpdated: new Date().toISOString(),
            });
          } catch (err) {
            logger.error(
              `Failed to update weight for ${backend}/${server}: ${err.message}`
            );
          }
        }

        // Commit the transaction if we made changes
        if (changes.length > 0) {
          await this.commitTransaction(transaction);
          logger.info(`Applied ${changes.length} server weight changes`);
        } else {
          await this.abortTransaction(transaction);
        }
      } catch (err) {
        // Abort transaction on error
        await this.abortTransaction(transaction);
        throw err;
      }
    } catch (err) {
      logger.error(`Failed to apply server weights: ${err.message}`);
    }

    return changes;
  }

  /**
   * Update content-based routing rules
   * @returns {Promise<Array>} List of changes made
   * @private
   */
  async updateContentRouting() {
    const changes = [];

    if (this.contentRules.size === 0) {
      return changes;
    }

    try {
      // Start a transaction for all changes
      const transaction = await this.startTransaction();

      try {
        // Get existing ACLs and rules
        const existingAcls = new Map();

        for (const [id, acl] of this.acls.entries()) {
          if (acl.name.startsWith("content_")) {
            existingAcls.set(acl.name, acl);
          }
        }

        // Process content rules
        for (const [name, rule] of this.contentRules.entries()) {
          const aclName = `content_${name}`;

          // Check if this ACL already exists
          const existingAcl = existingAcls.get(aclName);

          if (!existingAcl) {
            try {
              // Create new ACL for this content rule
              const aclData = {
                name: aclName,
                criterion: "path",
                value: rule.pattern,
                parent_type: "frontend",
                parent_name: "https-in", // Assume this is the main frontend
              };

              const aclResponse = await this.apiClient.post(
                `/services/haproxy/configuration/acls?transaction_id=${transaction}`,
                aclData
              );

              const newAcl = aclResponse.data.data;

              // Create use_backend rule using this ACL
              const useBackendData = {
                name: `content_rule_${name}`,
                cond: "if",
                cond_test: aclName,
                backend: rule.targetBackend,
                frontend: "https-in",
              };

              await this.apiClient.post(
                `/services/haproxy/configuration/backend_switching_rules?transaction_id=${transaction}`,
                useBackendData
              );

              changes.push({
                type: "content_rule_add",
                name,
                acl: aclName,
                pattern: rule.pattern,
                backend: rule.targetBackend,
              });

              // Update ACLs map
              this.acls.set(newAcl.id, {
                id: newAcl.id,
                name: newAcl.name,
                criterion: newAcl.criterion,
                value: newAcl.value,
                parent_type: newAcl.parent_type,
                parent_name: newAcl.parent_name,
              });
            } catch (err) {
              logger.error(
                `Failed to create content rule ${name}: ${err.message}`
              );
            }
          }
        }

        // Commit the transaction if we made changes
        if (changes.length > 0) {
          await this.commitTransaction(transaction);
          logger.info(`Applied ${changes.length} content routing rules`);
        } else {
          await this.abortTransaction(transaction);
        }
      } catch (err) {
        // Abort transaction on error
        await this.abortTransaction(transaction);
        throw err;
      }
    } catch (err) {
      logger.error(`Failed to update content routing: ${err.message}`);
    }

    return changes;
  }

  /**
   * Update geographic routing rules
   * @returns {Promise<Array>} List of changes made
   * @private
   */
  async updateGeoRouting() {
    const changes = [];

    if (this.geoMapping.size === 0) {
      return changes;
    }

    try {
      // Start a transaction for all changes
      const transaction = await this.startTransaction();

      try {
        // Get existing ACLs and rules
        const existingAcls = new Map();

        for (const [id, acl] of this.acls.entries()) {
          if (acl.name.startsWith("geo_")) {
            existingAcls.set(acl.name, acl);
          }
        }

        // Process geo mappings
        for (const [region, mapping] of this.geoMapping.entries()) {
          const aclName = `geo_${region}`;

          // Check if this ACL already exists
          const existingAcl = existingAcls.get(aclName);

          if (!existingAcl) {
            try {
              // Create new ACL for this geo region
              const aclData = {
                name: aclName,
                criterion: "hdr(CF-IPCountry)",
                value: mapping.countries.join(" "),
                parent_type: "frontend",
                parent_name: "https-in", // Assume this is the main frontend
              };

              const aclResponse = await this.apiClient.post(
                `/services/haproxy/configuration/acls?transaction_id=${transaction}`,
                aclData
              );

              const newAcl = aclResponse.data.data;

              // Create use_backend rule using this ACL
              const useBackendData = {
                name: `geo_rule_${region}`,
                cond: "if",
                cond_test: aclName,
                backend: mapping.preferredBackend,
                frontend: "https-in",
              };

              await this.apiClient.post(
                `/services/haproxy/configuration/backend_switching_rules?transaction_id=${transaction}`,
                useBackendData
              );

              changes.push({
                type: "geo_rule_add",
                region,
                acl: aclName,
                countries: mapping.countries,
                backend: mapping.preferredBackend,
              });

              // Update ACLs map
              this.acls.set(newAcl.id, {
                id: newAcl.id,
                name: newAcl.name,
                criterion: newAcl.criterion,
                value: newAcl.value,
                parent_type: newAcl.parent_type,
                parent_name: newAcl.parent_name,
              });
            } catch (err) {
              logger.error(
                `Failed to create geo rule ${region}: ${err.message}`
              );
            }
          }
        }

        // Commit the transaction if we made changes
        if (changes.length > 0) {
          await this.commitTransaction(transaction);
          logger.info(`Applied ${changes.length} geo routing rules`);
        } else {
          await this.abortTransaction(transaction);
        }
      } catch (err) {
        // Abort transaction on error
        await this.abortTransaction(transaction);
        throw err;
      }
    } catch (err) {
      logger.error(`Failed to update geo routing: ${err.message}`);
    }

    return changes;
  }

  /**
   * Start a transaction for batch configuration changes
   * @returns {Promise<string>} Transaction ID
   * @private
   */
  async startTransaction() {
    try {
      const response = await withRetry(
        () => this.apiClient.post("/services/haproxy/transactions"),
        { retries: 3, delay: 1000 }
      );

      return response.data.data.id;
    } catch (err) {
      logger.error(`Failed to start transaction: ${err.message}`);
      throw err;
    }
  }

  /**
   * Commit a transaction
   * @param {string} id - Transaction ID
   * @returns {Promise<boolean>} Success status
   * @private
   */
  async commitTransaction(id) {
    try {
      await withRetry(
        () => this.apiClient.put(`/services/haproxy/transactions/${id}`),
        { retries: 3, delay: 1000 }
      );

      return true;
    } catch (err) {
      logger.error(`Failed to commit transaction: ${err.message}`);
      throw err;
    }
  }

  /**
   * Abort a transaction
   * @param {string} id - Transaction ID
   * @returns {Promise<boolean>} Success status
   * @private
   */
  async abortTransaction(id) {
    try {
      await this.apiClient.delete(`/services/haproxy/transactions/${id}`);
      return true;
    } catch (err) {
      logger.error(`Failed to abort transaction: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get routing status
   * @returns {Object} Current routing status
   */
  getRoutingStatus() {
    return {
      initialized: this.initialized,
      isUpdating: this.isUpdating,
      lastUpdateTime: this.lastUpdateTime
        ? this.lastUpdateTime.toISOString()
        : null,
      backendCount: this.routingTable.size,
      serverCount: [...this.routingTable.values()].reduce(
        (sum, backend) => sum + backend.servers.length,
        0
      ),
      contentRules: this.contentRules.size,
      geoMappings: this.geoMapping.size,
      dynamicWeightCount: this.dynamicWeights.size,
      features: {
        geoRouting: this.enableGeoRouting,
        contentAwareRouting: this.enableContentAwareRouting,
      },
    };
  }

  /**
   * Get current routing configuration
   * @returns {Object} Current routing configuration
   */
  getRoutingConfiguration() {
    return {
      backends: Array.from(this.routingTable.values()),
      contentRules: Array.from(this.contentRules.values()),
      geoMappings: Array.from(this.geoMapping.values()),
      dynamicWeights: Array.from(this.dynamicWeights.values()),
    };
  }

  /**
   * Get server performance metrics
   * @param {string} backend - Optional backend name to filter by
   * @returns {Array} Server performance metrics
   */
  getServerPerformance(backend = null) {
    const results = [];

    for (const [key, performance] of this.serverPerformance.entries()) {
      const [serverBackend, server] = key.split("/");

      if (!backend || serverBackend === backend) {
        results.push({
          backend: serverBackend,
          server,
          status: performance.status,
          responseTime: performance.responseTime,
          errorRate: performance.errorRate,
          currentConnections: performance.currentConnections,
          lastUpdated: performance.lastUpdated,
        });
      }
    }

    return results;
  }

  /**
   * Get routing history
   * @param {number} limit - Maximum number of entries to return
   * @returns {Array} Routing history
   */
  getRoutingHistory(limit = 10) {
    return this.routingHistory.slice(-limit);
  }

  /**
   * Force an immediate routing update
   * @returns {Promise<Object>} Update results
   */
  async forceUpdate() {
    logger.info("Forcing immediate routing update");
    return await this.updateRoutingConfiguration();
  }

  /**
   * Update content routing rules
   * @param {Array} rules - New content routing rules
   * @returns {Promise<boolean>} Success status
   */
  async updateContentRules(rules) {
    if (!Array.isArray(rules) || rules.length === 0) {
      return false;
    }

    try {
      // Clear existing rules
      this.contentRules.clear();

      // Add new rules
      for (const rule of rules) {
        if (rule.name && rule.pattern && rule.targetBackend) {
          this.contentRules.set(rule.name, {
            name: rule.name,
            pattern: rule.pattern,
            targetBackend: rule.targetBackend,
            priority: rule.priority || 100,
          });
        }
      }

      // Force an update
      await this.updateRoutingConfiguration();
      return true;
    } catch (err) {
      logger.error(`Failed to update content rules: ${err.message}`);
      return false;
    }
  }

  /**
   * Update geographic routing mappings
   * @param {Array} mappings - New geographic mappings
   * @returns {Promise<boolean>} Success status
   */
  async updateGeoMappings(mappings) {
    if (!Array.isArray(mappings) || mappings.length === 0) {
      return false;
    }

    try {
      // Clear existing mappings
      this.geoMapping.clear();

      // Add new mappings
      for (const mapping of mappings) {
        if (mapping.region && mapping.countries && mapping.preferredBackend) {
          this.geoMapping.set(mapping.region, {
            region: mapping.region,
            countries: Array.isArray(mapping.countries)
              ? mapping.countries
              : [mapping.countries],
            preferredBackend: mapping.preferredBackend,
            priority: mapping.priority || 100,
          });
        }
      }

      // Force an update
      await this.updateRoutingConfiguration();
      return true;
    } catch (err) {
      logger.error(`Failed to update geo mappings: ${err.message}`);
      return false;
    }
  }

  /**
   * Enable/disable geographic routing
   * @param {boolean} enabled - Whether to enable geographic routing
   */
  setGeoRouting(enabled) {
    this.enableGeoRouting = !!enabled;
    logger.info(
      `Geographic routing ${this.enableGeoRouting ? "enabled" : "disabled"}`
    );

    // Force a routing update
    this.updateRoutingConfiguration().catch((err) => {
      logger.error(
        `Failed to update routing after geo setting change: ${err.message}`
      );
    });
  }

  /**
   * Enable/disable content-aware routing
   * @param {boolean} enabled - Whether to enable content-aware routing
   */
  setContentAwareRouting(enabled) {
    this.enableContentAwareRouting = !!enabled;
    logger.info(
      `Content-aware routing ${
        this.enableContentAwareRouting ? "enabled" : "disabled"
      }`
    );

    // Force a routing update
    this.updateRoutingConfiguration().catch((err) => {
      logger.error(
        `Failed to update routing after content routing setting change: ${err.message}`
      );
    });
  }

  /**
   * Set routing decision weights
   * @param {Object} weights - Decision weights
   * @param {number} weights.performanceWeight - Weight for performance in decisions
   * @param {number} weights.loadWeight - Weight for load balancing in decisions
   */
  setDecisionWeights(weights) {
    if (weights && typeof weights === "object") {
      if (typeof weights.performanceWeight === "number") {
        this.performanceWeight = Math.max(
          0,
          Math.min(1, weights.performanceWeight)
        );
      }

      if (typeof weights.loadWeight === "number") {
        this.loadWeight = Math.max(0, Math.min(1, weights.loadWeight));
      }

      logger.info(
        `Updated routing decision weights: performance=${this.performanceWeight}, load=${this.loadWeight}`
      );
    }
  }

  /**
   * Shut down the routing manager
   */
  shutdown() {
    this.stopRoutingUpdates();
    logger.info("Intelligent routing manager shutdown");
  }
}

module.exports = IntelligentRoutingManager;
