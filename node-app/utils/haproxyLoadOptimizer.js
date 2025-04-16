/**
 * HAProxy Load Optimizer
 *
 * Advanced load optimization for HAProxy that:
 * - Dynamically adjusts server weights based on real-time performance metrics
 * - Implements adaptive load balancing algorithms
 * - Provides predictive scaling recommendations
 * - Optimizes traffic distribution across heterogeneous infrastructure
 * - Works with the metrics manager to make data-driven load balancing decisions
 */

const EventEmitter = require("events");
const logger = require("./logger").getLogger("haproxyLoadOptimizer");
const { withRetry } = require("./retryHandler");

class HAProxyLoadOptimizer extends EventEmitter {
  /**
   * Create a new HAProxy load optimizer
   * @param {Object} options - Configuration options
   * @param {Object} options.apiClient - HAProxy Data Plane API client
   * @param {Object} options.metricsManager - HAProxy metrics manager
   * @param {Number} options.optimizationInterval - Optimization interval in ms (default: 30s)
   * @param {Number} options.adaptationRate - Rate of adaptation (0-1, default: 0.3)
   * @param {Boolean} options.enablePredictiveScaling - Enable predictive scaling (default: true)
   * @param {String} options.algorithm - Load balancing algorithm (adaptive, predictive, balanced)
   * @param {Object} options.weights - Algorithm weights configuration
   * @param {Number} options.weights.performance - Weight for performance factors (default: 0.5)
   * @param {Number} options.weights.utilization - Weight for utilization factors (default: 0.3)
   * @param {Number} options.weights.stability - Weight for stability factors (default: 0.2)
   */
  constructor(options = {}) {
    super();

    this.apiClient = options.apiClient;
    this.metricsManager = options.metricsManager;
    this.optimizationInterval = options.optimizationInterval || 30 * 1000; // 30 seconds
    this.adaptationRate = Math.min(
      1,
      Math.max(0, options.adaptationRate || 0.3)
    ); // Limit between 0 and 1
    this.enablePredictiveScaling = options.enablePredictiveScaling !== false;
    this.algorithm = options.algorithm || "adaptive"; // adaptive, predictive, balanced

    // Algorithm weight factors
    const weights = options.weights || {};
    this.weights = {
      performance: weights.performance || 0.5,
      utilization: weights.utilization || 0.3,
      stability: weights.stability || 0.2,
    };

    // Normalize weights to sum to 1
    const totalWeight =
      this.weights.performance +
      this.weights.utilization +
      this.weights.stability;
    if (totalWeight !== 1) {
      this.weights.performance /= totalWeight;
      this.weights.utilization /= totalWeight;
      this.weights.stability /= totalWeight;
    }

    // State tracking
    this.initialized = false;
    this.optimizationTimer = null;
    this.isOptimizing = false;
    this.lastOptimizationTime = null;

    // Server tracking and load state
    this.backends = new Map();
    this.serverWeights = new Map();
    this.loadHistory = [];
    this.weightHistory = [];
    this.predictiveModel = {};
    this.anomalyThresholds = new Map();
    this.trafficPatterns = new Map();

    // Track changes for verification
    this.pendingChanges = [];
    this.changeHistory = [];

    // Bind methods
    this.optimizeLoad = this.optimizeLoad.bind(this);
  }

  /**
   * Initialize the load optimizer
   * @returns {Promise<boolean>} Initialization result
   */
  async initialize() {
    try {
      logger.info("Initializing HAProxy load optimizer");

      // Check if dependencies are available
      if (!this.apiClient) {
        logger.error("API client is required for load optimizer");
        return false;
      }

      if (!this.metricsManager) {
        logger.error("Metrics manager is required for load optimizer");
        return false;
      }

      // Ensure metrics manager is initialized
      if (!this.metricsManager.initialized) {
        logger.info("Waiting for metrics manager to initialize");
        await this.metricsManager.initialize();
      }

      // Load current configuration
      await this.loadCurrentConfiguration();

      // Generate initial anomaly thresholds
      this.calculateAnomalyThresholds();

      // Start optimization loop
      this.startOptimization();

      // Set up listeners for metric events
      this.setupEventListeners();

      this.initialized = true;
      logger.info(
        `HAProxy load optimizer initialized (algorithm: ${this.algorithm})`
      );
      return true;
    } catch (err) {
      logger.error(`Failed to initialize load optimizer: ${err.message}`);
      return false;
    }
  }

  /**
   * Set up event listeners for metrics and anomaly events
   * @private
   */
  setupEventListeners() {
    // Listen for metric collection events
    if (this.metricsManager) {
      this.metricsManager.on("metrics-collected", (data) => {
        // Trigger optimization if anomalies are detected or significant changes occurred
        const metrics = this.metricsManager.getCurrentMetrics();
        if (this.shouldTriggerOptimization(metrics)) {
          logger.info("Triggering optimization due to metric change event");
          this.optimizeLoad().catch((err) => {
            logger.error(
              `Optimization triggered by event failed: ${err.message}`
            );
          });
        }
      });

      // Listen for anomaly events to take immediate action
      this.metricsManager.on("anomalies-detected", (data) => {
        if (data.anomalies && data.anomalies.length > 0) {
          const criticalAnomalies = data.anomalies.filter(
            (a) => a.severity === "critical"
          );
          if (criticalAnomalies.length > 0) {
            logger.warn(
              `Detected ${criticalAnomalies.length} critical anomalies, triggering immediate optimization`
            );
            this.optimizeLoad(true).catch((err) => {
              logger.error(`Emergency optimization failed: ${err.message}`);
            });
          }
        }
      });
    }
  }

  /**
   * Determine if an optimization should be triggered based on metrics
   * @param {Object} metrics - Current metrics
   * @returns {boolean} Whether optimization should be triggered
   * @private
   */
  shouldTriggerOptimization(metrics) {
    if (!metrics || !metrics.haproxy || !metrics.haproxy.stats) {
      return false;
    }

    // Check for high queue sizes
    const highQueue = metrics.haproxy.stats.some((stat) => {
      return stat.type === "backend" && parseInt(stat.qcur || 0, 10) > 5;
    });

    if (highQueue) {
      return true;
    }

    // Check for servers nearing capacity
    const highLoad = metrics.haproxy.stats.some((stat) => {
      if (stat.type === "server") {
        const maxConn = parseInt(stat.slim || 0, 10);
        if (maxConn > 0) {
          const current = parseInt(stat.scur || 0, 10);
          // If server is at > 80% capacity
          return current / maxConn > 0.8;
        }
      }
      return false;
    });

    if (highLoad) {
      return true;
    }

    // Not urgent enough to trigger an out-of-band optimization
    return false;
  }

  /**
   * Load current HAProxy configuration
   * @returns {Promise<void>}
   * @private
   */
  async loadCurrentConfiguration() {
    try {
      logger.info("Loading current HAProxy backend configuration");

      // Get all backends
      const backendsResponse = await withRetry(
        () => this.apiClient.get("/services/haproxy/configuration/backends"),
        { retries: 3, delay: 1000 }
      );

      const backends = backendsResponse.data.data;

      // Ensure backends is an array before iterating
      if (!Array.isArray(backends)) {
        logger.warn("No backends available or backends not in expected format");
        return; // Exit early if not an array
      }

      // Process each backend
      for (const backend of backends) {
        const backendName = backend.name;

        // Skip internal or special backends
        if (
          backendName === "stats" ||
          backendName.includes("dataplane") ||
          backendName.includes("admin")
        ) {
          continue;
        }

        // Get servers for this backend
        const servers = [];

        if (backend.servers && backend.servers.length > 0) {
          for (const server of backend.servers) {
            const serverConfig = {
              name: server.name,
              address: server.address,
              port: server.port,
              weight: parseInt(server.weight || "100", 10),
              maxconn: parseInt(server.maxconn || "0", 10),
              check: server.check === "enabled",
              backup: server.backup === "enabled",
              lastModified: new Date().toISOString(),
            };

            // Store server weight
            this.serverWeights.set(
              `${backendName}/${server.name}`,
              serverConfig.weight
            );

            servers.push(serverConfig);
          }
        }

        // Store backend configuration
        this.backends.set(backendName, {
          name: backendName,
          servers,
          balance: backend.balance || "roundrobin",
          mode: backend.mode || "http",
          lastUpdated: new Date().toISOString(),
        });
      }

      logger.info(
        `Loaded configuration: ${this.backends.size} backends, ${this.serverWeights.size} servers`
      );
    } catch (err) {
      logger.error(`Failed to load HAProxy configuration: ${err.message}`);
      throw err;
    }
  }

  /**
   * Start periodic load optimization
   */
  startOptimization() {
    if (this.optimizationTimer) {
      clearInterval(this.optimizationTimer);
    }

    logger.info(
      `Starting load optimization with interval of ${
        this.optimizationInterval / 1000
      }s`
    );

    // Start with an immediate optimization
    setTimeout(() => {
      this.optimizeLoad().catch((err) => {
        logger.error(`Initial load optimization failed: ${err.message}`);
      });
    }, 5000);

    // Schedule regular optimizations
    this.optimizationTimer = setInterval(
      this.optimizeLoad,
      this.optimizationInterval
    );
  }

  /**
   * Stop load optimization
   */
  stopOptimization() {
    if (this.optimizationTimer) {
      clearInterval(this.optimizationTimer);
      this.optimizationTimer = null;
      logger.info("Load optimization stopped");
    }
  }

  /**
   * Optimize load distribution based on current metrics
   * @param {boolean} emergency - Whether this is an emergency optimization
   * @returns {Promise<Object>} Optimization results
   */
  async optimizeLoad(emergency = false) {
    if (this.isOptimizing) {
      logger.debug("Load optimization already in progress, skipping");
      return {
        success: false,
        reason: "optimization_in_progress",
      };
    }

    this.isOptimizing = true;

    try {
      const startTime = Date.now();
      logger.info(`Starting ${emergency ? "emergency " : ""}load optimization`);

      // Get latest metrics
      const metrics = this.metricsManager.getCurrentMetrics();
      if (!metrics || !metrics.haproxy || !metrics.haproxy.stats) {
        logger.warn("No metrics available for optimization");
        return { success: false, reason: "no_metrics" };
      }

      // Perform optimization based on selected algorithm
      let weightChanges;
      switch (this.algorithm) {
        case "predictive":
          weightChanges = await this.predictiveOptimization(metrics, emergency);
          break;
        case "balanced":
          weightChanges = await this.balancedOptimization(metrics, emergency);
          break;
        case "adaptive":
        default:
          weightChanges = await this.adaptiveOptimization(metrics, emergency);
          break;
      }

      // Apply the weight changes
      const result = await this.applyWeightChanges(weightChanges);

      // Store optimization in history
      this.loadHistory.push({
        timestamp: new Date().toISOString(),
        duration: Date.now() - startTime,
        algorithm: this.algorithm,
        emergency,
        changes: result.changes.length,
        metrics: {
          backends: metrics.haproxy.stats.filter((s) => s.type === "backend")
            .length,
          activeConnections: metrics.haproxy.stats.reduce(
            (sum, s) => sum + parseInt(s.scur || 0, 10),
            0
          ),
          serverCount: this.serverWeights.size,
        },
      });

      // Keep history manageable
      if (this.loadHistory.length > 100) {
        this.loadHistory.shift();
      }

      // Update last optimization time
      this.lastOptimizationTime = new Date();

      // Emit optimization event
      this.emit("optimization-complete", {
        timestamp: this.lastOptimizationTime.toISOString(),
        emergency,
        algorithm: this.algorithm,
        changes: result.changes.length,
        duration: Date.now() - startTime,
      });

      logger.info(
        `Load optimization completed in ${Date.now() - startTime}ms with ${
          result.changes.length
        } changes`
      );

      return {
        success: true,
        timestamp: this.lastOptimizationTime.toISOString(),
        algorithm: this.algorithm,
        emergency,
        changes: result.changes,
        duration: Date.now() - startTime,
      };
    } catch (err) {
      logger.error(`Load optimization failed: ${err.message}`);

      // Emit failure event
      this.emit("optimization-failed", {
        timestamp: new Date().toISOString(),
        error: err.message,
      });

      return {
        success: false,
        error: err.message,
      };
    } finally {
      this.isOptimizing = false;
    }
  }

  /**
   * Adaptive optimization algorithm - adapts to changing conditions
   * @param {Object} metrics - Current metrics
   * @param {boolean} emergency - Whether this is an emergency optimization
   * @returns {Array} Weight changes to apply
   * @private
   */
  async adaptiveOptimization(metrics, emergency) {
    const weightChanges = [];
    const adaptationFactor = emergency ? 0.6 : this.adaptationRate;

    try {
      logger.debug(
        `Running adaptive optimization (factor: ${adaptationFactor})`
      );

      // Group stats by backend
      const backendStats = new Map();

      // Get backend stats
      for (const stat of metrics.haproxy.stats) {
        if (stat.type === "backend") {
          backendStats.set(stat.pxname, {
            backend: stat,
            servers: [],
          });
        }
      }

      // Add server stats to their backends
      for (const stat of metrics.haproxy.stats) {
        if (
          stat.type === "server" &&
          stat.svname !== "BACKEND" &&
          stat.svname !== "FRONTEND"
        ) {
          const backendData = backendStats.get(stat.pxname);
          if (backendData) {
            backendData.servers.push(stat);
          }
        }
      }

      // Process each backend
      for (const [backendName, data] of backendStats.entries()) {
        // Skip backends with no servers or only one server
        if (!data.servers.length || data.servers.length < 2) {
          continue;
        }

        const backend = this.backends.get(backendName);
        if (!backend) continue;

        // Calculate scores for each server
        const scoredServers = data.servers
          .map((server) => {
            // Get current weights
            const key = `${backendName}/${server.svname}`;
            const currentWeight = this.serverWeights.get(key) || 100;

            // Skip servers that are down
            if (server.status !== "UP") {
              return {
                key,
                name: server.svname,
                currentWeight,
                optimalWeight: 0, // Will be taken out of rotation
                score: 0,
                status: server.status,
              };
            }

            // Calculate performance score components

            // Response time score (lower is better)
            const rtime = parseInt(server.rtime || 0, 10);
            const responseTimeScore =
              rtime === 0 ? 100 : 100 / (1 + Math.log10(rtime));

            // Error rate score (lower is better)
            const errorRate = this.calculateErrorRate(server);
            const errorRateScore = 100 - Math.min(100, errorRate * 20);

            // Queue score (lower is better)
            const queueSize = parseInt(server.qcur || 0, 10);
            const queueScore = queueSize === 0 ? 100 : 100 / (1 + queueSize);

            // Current connections vs max connections (lower is better)
            const currentConn = parseInt(server.scur || 0, 10);
            const maxConn = parseInt(server.slim || 0, 10);
            const utilizationScore =
              maxConn === 0 ? 50 : 100 * (1 - currentConn / maxConn);

            // Calculate weighted score
            const performanceComponent =
              responseTimeScore * 0.5 + errorRateScore * 0.3 + queueScore * 0.2;
            const score =
              performanceComponent * this.weights.performance +
              utilizationScore * this.weights.utilization +
              (currentWeight * this.weights.stability) / 100; // Normalize weight to 0-100

            return {
              key,
              name: server.svname,
              currentWeight,
              score,
              metrics: {
                responseTime: rtime,
                errorRate,
                queueSize,
                utilization: maxConn === 0 ? 0 : currentConn / maxConn,
              },
              status: server.status,
            };
          })
          .filter((s) => s.status === "UP"); // Only include active servers

        // Calculate new weights based on scores
        const totalScore = scoredServers.reduce((sum, s) => sum + s.score, 0);

        if (scoredServers.length > 0 && totalScore > 0) {
          // Calculate initial optimal weights
          for (const server of scoredServers) {
            // Score-based weight distribution
            const rawOptimalWeight = Math.max(
              1,
              Math.round(
                (server.score / totalScore) * scoredServers.length * 100
              )
            );

            // Apply adaptation factor for stability
            const adaptedWeight = Math.round(
              server.currentWeight * (1 - adaptationFactor) +
                rawOptimalWeight * adaptationFactor
            );

            // Ensure weight is within bounds
            const finalWeight = Math.max(1, Math.min(256, adaptedWeight));

            // Only register change if significant enough
            if (Math.abs(finalWeight - server.currentWeight) >= 5) {
              server.optimalWeight = finalWeight;

              weightChanges.push({
                key: server.key,
                backend: backendName,
                server: server.name,
                currentWeight: server.currentWeight,
                optimalWeight: finalWeight,
                reason: "adaptive",
                score: server.score.toFixed(2),
                metrics: server.metrics,
              });
            }
          }
        }
      }

      logger.debug(
        `Adaptive optimization generated ${weightChanges.length} weight changes`
      );
      return weightChanges;
    } catch (err) {
      logger.error(`Adaptive optimization failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Predictive optimization algorithm - uses traffic patterns to predict future load
   * @param {Object} metrics - Current metrics
   * @param {boolean} emergency - Whether this is an emergency optimization
   * @returns {Array} Weight changes to apply
   * @private
   */
  async predictiveOptimization(metrics, emergency) {
    const weightChanges = [];
    const adaptationFactor = emergency ? 0.7 : this.adaptationRate;

    try {
      logger.debug(
        `Running predictive optimization (factor: ${adaptationFactor})`
      );

      // Update traffic patterns
      this.updateTrafficPatterns(metrics);

      // Process each backend with its servers
      for (const [backendName, backend] of this.backends.entries()) {
        // Skip backends with no servers or only one server
        if (!backend.servers.length || backend.servers.length < 2) {
          continue;
        }

        // Get current backend stats
        const backendStat = metrics.haproxy.stats.find(
          (s) => s.type === "backend" && s.pxname === backendName
        );

        if (!backendStat) continue;

        // Predict trend for this backend
        const predictedLoad = this.predictLoadTrend(backendName, backendStat);

        // Get all active servers for this backend
        const serverStats = metrics.haproxy.stats.filter(
          (s) =>
            s.type === "server" && s.pxname === backendName && s.status === "UP"
        );

        if (serverStats.length < 2) continue;

        // Calculate scores based on current metrics + predicted load
        const scoredServers = serverStats.map((server) => {
          const key = `${backendName}/${server.svname}`;
          const currentWeight = this.serverWeights.get(key) || 100;

          // Basic performance metrics
          const rtime = parseInt(server.rtime || 0, 10);
          const errorRate = this.calculateErrorRate(server);
          const qtime = parseInt(server.qtime || 0, 10);

          // Current resource utilization
          const currentConn = parseInt(server.scur || 0, 10);
          const maxConn = parseInt(server.slim || 0, 10);
          const utilization = maxConn === 0 ? 0 : currentConn / maxConn;

          // Predictive component - how well can this server handle predicted load?
          // Lower utilization = more headroom for increased load
          const headroom = maxConn === 0 ? 0.5 : Math.max(0, 1 - utilization);

          // Calculate predictive score
          // If predicted load is increasing, favor servers with more headroom
          // If predicted load is decreasing, weight becomes more balanced
          const performanceScore =
            (100 / (1 + Math.log10(1 + rtime))) * 0.5 + // Response time component
            (100 - Math.min(100, errorRate * 20)) * 0.3 + // Error rate component
            (100 / (1 + qtime)) * 0.2; // Queue time component

          // Adjust for predicted load - trending up means we need more headroom
          const predictiveComponent =
            predictedLoad.trend > 0
              ? headroom * 100 // If load increasing, prioritize servers with capacity
              : 50; // If stable/decreasing, more balanced distribution

          // Final score calculation
          const score =
            performanceScore * this.weights.performance +
            predictiveComponent * this.weights.utilization +
            (currentWeight * this.weights.stability) / 100;

          return {
            key,
            name: server.svname,
            currentWeight,
            score,
            metrics: {
              responseTime: rtime,
              errorRate,
              utilization,
              headroom,
            },
          };
        });

        // Calculate weights based on scores
        const totalScore = scoredServers.reduce((sum, s) => sum + s.score, 0);

        if (scoredServers.length > 0 && totalScore > 0) {
          for (const server of scoredServers) {
            // Raw optimal weight based on score ratio
            const rawOptimalWeight = Math.max(
              1,
              Math.round(
                (server.score / totalScore) * scoredServers.length * 100
              )
            );

            // Apply adaptation factor for stability
            const adaptedWeight = Math.round(
              server.currentWeight * (1 - adaptationFactor) +
                rawOptimalWeight * adaptationFactor
            );

            // Ensure weight is within bounds
            const finalWeight = Math.max(1, Math.min(256, adaptedWeight));

            // Only register change if significant enough
            if (Math.abs(finalWeight - server.currentWeight) >= 5) {
              weightChanges.push({
                key: server.key,
                backend: backendName,
                server: server.name,
                currentWeight: server.currentWeight,
                optimalWeight: finalWeight,
                reason: "predictive",
                trendDirection: predictedLoad.trend > 0 ? "up" : "down",
                score: server.score.toFixed(2),
                metrics: server.metrics,
              });
            }
          }
        }
      }

      logger.debug(
        `Predictive optimization generated ${weightChanges.length} weight changes`
      );
      return weightChanges;
    } catch (err) {
      logger.error(`Predictive optimization failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Balanced optimization algorithm - focuses on even distribution with slight performance weighting
   * @param {Object} metrics - Current metrics
   * @param {boolean} emergency - Whether this is an emergency optimization
   * @returns {Array} Weight changes to apply
   * @private
   */
  async balancedOptimization(metrics, emergency) {
    const weightChanges = [];
    const adaptationFactor = emergency ? 0.5 : this.adaptationRate;

    try {
      logger.debug(
        `Running balanced optimization (factor: ${adaptationFactor})`
      );

      // Group stats by backend
      const backendStats = new Map();

      // Get backend stats
      for (const stat of metrics.haproxy.stats) {
        if (stat.type === "backend") {
          backendStats.set(stat.pxname, {
            backend: stat,
            servers: [],
          });
        }
      }

      // Add server stats to their backends
      for (const stat of metrics.haproxy.stats) {
        if (
          stat.type === "server" &&
          stat.svname !== "BACKEND" &&
          stat.svname !== "FRONTEND"
        ) {
          const backendData = backendStats.get(stat.pxname);
          if (backendData) {
            backendData.servers.push(stat);
          }
        }
      }

      // Process each backend
      for (const [backendName, data] of backendStats.entries()) {
        if (!data.servers.length || data.servers.length < 2) continue;

        const backend = this.backends.get(backendName);
        if (!backend) continue;

        // For balanced algorithm, we want to ensure:
        // 1. Even distribution as a baseline
        // 2. Small adjustments based on performance
        // 3. Take servers out if they're performing poorly

        // Calculate performance factor for each server
        const serverPerformance = data.servers
          .filter((server) => server.status === "UP")
          .map((server) => {
            const key = `${backendName}/${server.svname}`;
            const currentWeight = this.serverWeights.get(key) || 100;

            // Simple performance score (higher is better)
            const rtime = parseInt(server.rtime || 0, 10) || 1;
            const errorRate = this.calculateErrorRate(server);
            const perfScore = (100 / rtime) * (1 - errorRate / 100);

            return {
              key,
              name: server.svname,
              currentWeight,
              perfScore,
            };
          });

        // Skip if no active servers
        if (serverPerformance.length === 0) continue;

        // Calculate average performance score
        const avgPerfScore =
          serverPerformance.reduce((sum, s) => sum + s.perfScore, 0) /
          serverPerformance.length;

        // Calculate weights - mostly balanced but slightly favor better performers
        for (const server of serverPerformance) {
          // Start with base weight of 100 for balance
          const baseWeight = 100;

          // Performance adjustment - up to +/- 30% based on relative performance
          const perfRatio = server.perfScore / avgPerfScore;
          const perfAdjustment = (perfRatio - 1) * 30; // +/- 30% max adjustment

          // Calculate raw optimal weight
          const rawOptimalWeight = Math.round(
            baseWeight * (1 + perfAdjustment / 100)
          );

          // Apply adaptation factor
          const adaptedWeight = Math.round(
            server.currentWeight * (1 - adaptationFactor) +
              rawOptimalWeight * adaptationFactor
          );

          // Ensure weight is within bounds
          const finalWeight = Math.max(1, Math.min(256, adaptedWeight));

          // Only register change if significant enough
          if (Math.abs(finalWeight - server.currentWeight) >= 5) {
            weightChanges.push({
              key: server.key,
              backend: backendName,
              server: server.name,
              currentWeight: server.currentWeight,
              optimalWeight: finalWeight,
              reason: "balanced",
              perfRatio: perfRatio.toFixed(2),
            });
          }
        }
      }

      logger.debug(
        `Balanced optimization generated ${weightChanges.length} weight changes`
      );
      return weightChanges;
    } catch (err) {
      logger.error(`Balanced optimization failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Apply weight changes to servers
   * @param {Array} weightChanges - Array of weight changes to apply
   * @returns {Promise<Object>} Result of applying changes
   * @private
   */
  async applyWeightChanges(weightChanges) {
    const applied = [];
    const failed = [];

    if (weightChanges.length === 0) {
      return {
        success: true,
        changes: [],
        timestamp: new Date().toISOString(),
      };
    }

    try {
      logger.info(`Applying ${weightChanges.length} weight changes`);

      // Start transaction for batch changes
      const transactionResponse = await withRetry(
        () => this.apiClient.post("/services/haproxy/transactions"),
        { retries: 3, delay: 1000 }
      );

      const transactionId = transactionResponse.data.data.id;
      logger.debug(`Started transaction ${transactionId} for weight changes`);

      try {
        // Apply each weight change
        for (const change of weightChanges) {
          try {
            const { backend, server, optimalWeight } = change;

            // Get current server configuration
            const serverResponse = await this.apiClient.get(
              `/services/haproxy/configuration/servers/${server}?backend=${backend}&transaction_id=${transactionId}`
            );

            const serverConfig = serverResponse.data.data;

            // Update weight
            serverConfig.weight = optimalWeight;

            // Apply change
            await this.apiClient.put(
              `/services/haproxy/configuration/servers/${server}?backend=${backend}&transaction_id=${transactionId}`,
              serverConfig
            );

            // Update tracking
            this.serverWeights.set(change.key, optimalWeight);

            // Add to applied changes
            applied.push({
              ...change,
              timestamp: new Date().toISOString(),
            });
          } catch (err) {
            logger.error(
              `Failed to update ${change.backend}/${change.server}: ${err.message}`
            );
            failed.push({
              ...change,
              error: err.message,
            });
          }
        }

        // Commit transaction only if we applied changes
        if (applied.length > 0) {
          await withRetry(
            () =>
              this.apiClient.put(
                `/services/haproxy/transactions/${transactionId}`
              ),
            { retries: 3, delay: 1000 }
          );

          logger.info(`Successfully applied ${applied.length} weight changes`);

          // Add to weight history
          this.weightHistory.push({
            timestamp: new Date().toISOString(),
            changes: applied,
          });

          // Keep history manageable
          if (this.weightHistory.length > 20) {
            this.weightHistory.shift();
          }
        } else {
          // Abort transaction if no changes were applied
          await this.apiClient.delete(
            `/services/haproxy/transactions/${transactionId}`
          );
          logger.info("No changes were applied, transaction aborted");
        }
      } catch (err) {
        // Abort transaction on error
        try {
          await this.apiClient.delete(
            `/services/haproxy/transactions/${transactionId}`
          );
        } catch (abortErr) {
          logger.error(`Failed to abort transaction: ${abortErr.message}`);
        }
        throw err;
      }

      return {
        success: true,
        changes: applied,
        failed,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      logger.error(`Failed to apply weight changes: ${err.message}`);
      return {
        success: false,
        error: err.message,
        changes: applied,
        failed: [
          ...failed,
          ...weightChanges.filter((c) => !applied.some((a) => a.key === c.key)),
        ],
      };
    }
  }

  /**
   * Update traffic patterns based on metrics
   * @param {Object} metrics - Current metrics
   * @private
   */
  updateTrafficPatterns(metrics) {
    // Skip if no metrics
    if (!metrics || !metrics.haproxy || !metrics.haproxy.stats) return;

    const now = new Date();
    // Get the day of week (0-6, 0 is Sunday) and hour (0-23)
    const dayOfWeek = now.getDay();
    const hour = now.getHours();
    const timeKey = `${dayOfWeek}-${hour}`;

    // Process each backend
    for (const stat of metrics.haproxy.stats) {
      if (stat.type !== "backend") continue;

      const backendName = stat.pxname;

      // Skip special backends
      if (
        backendName === "stats" ||
        backendName.includes("dataplane") ||
        backendName.includes("admin")
      ) {
        continue;
      }

      // Get or create pattern data for this backend
      if (!this.trafficPatterns.has(backendName)) {
        this.trafficPatterns.set(backendName, {
          timePatterns: new Map(),
          recentPatterns: [],
        });
      }

      const patternData = this.trafficPatterns.get(backendName);

      // Update time-based pattern
      if (!patternData.timePatterns.has(timeKey)) {
        patternData.timePatterns.set(timeKey, {
          samples: 0,
          avgConnections: 0,
          avgSessions: 0,
          avgQueueSize: 0,
        });
      }

      const timePattern = patternData.timePatterns.get(timeKey);

      // Update with exponential moving average
      const alpha = 0.3; // Weight for new value
      const connections = parseInt(stat.scur || 0, 10);
      const sessions = parseInt(stat.stot || 0, 10);
      const queueSize = parseInt(stat.qcur || 0, 10);

      if (timePattern.samples === 0) {
        // First sample
        timePattern.avgConnections = connections;
        timePattern.avgSessions = sessions;
        timePattern.avgQueueSize = queueSize;
      } else {
        // Update averages
        timePattern.avgConnections =
          timePattern.avgConnections * (1 - alpha) + connections * alpha;
        timePattern.avgSessions =
          timePattern.avgSessions * (1 - alpha) + sessions * alpha;
        timePattern.avgQueueSize =
          timePattern.avgQueueSize * (1 - alpha) + queueSize * alpha;
      }

      timePattern.samples += 1;

      // Update recent patterns (for trend analysis)
      patternData.recentPatterns.push({
        timestamp: now.toISOString(),
        connections,
        sessions,
        queueSize,
      });

      // Keep recent patterns manageable
      if (patternData.recentPatterns.length > 20) {
        patternData.recentPatterns.shift();
      }
    }
  }

  /**
   * Predict load trend for a specific backend
   * @param {string} backendName - Backend name
   * @param {Object} currentStats - Current backend stats
   * @returns {Object} Predicted load information
   * @private
   */
  predictLoadTrend(backendName, currentStats) {
    const result = {
      trend: 0, // -1: decreasing, 0: stable, 1: increasing
      confidence: 0,
      forecast: null,
    };

    // Get pattern data for this backend
    const patternData = this.trafficPatterns.get(backendName);
    if (!patternData || patternData.recentPatterns.length < 5) {
      return result; // Not enough data
    }

    // Simple linear regression on recent patterns
    const patterns = patternData.recentPatterns;
    const xValues = patterns.map((p, i) => i);
    const yValues = patterns.map((p) => p.connections);

    const n = patterns.length;
    const sumX = xValues.reduce((sum, val) => sum + val, 0);
    const sumY = yValues.reduce((sum, val) => sum + val, 0);
    const sumXY = xValues.reduce((sum, val, i) => sum + val * yValues[i], 0);
    const sumXX = xValues.reduce((sum, val) => sum + val * val, 0);

    // Calculate slope of the trend line
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);

    // Current connections
    const currentConn = parseInt(currentStats.scur || 0, 10);

    // Determine trend direction and confidence
    if (Math.abs(slope) < 0.1) {
      result.trend = 0; // Stable
      result.confidence = 0.7;
    } else if (slope > 0) {
      result.trend = 1; // Increasing
      result.confidence = Math.min(0.9, Math.abs(slope) / 2);
    } else {
      result.trend = -1; // Decreasing
      result.confidence = Math.min(0.9, Math.abs(slope) / 2);
    }

    // Simple forecast - next value
    const intercept = (sumY - slope * sumX) / n;
    const forecast = slope * n + intercept;

    result.forecast = {
      current: currentConn,
      next: Math.max(0, Math.round(forecast)),
      slope: slope.toFixed(3),
      percentChange:
        currentConn > 0
          ? (((forecast - currentConn) / currentConn) * 100).toFixed(1)
          : 0,
    };

    return result;
  }

  /**
   * Calculate error rate percentage from server stats
   * @param {Object} server - Server stats
   * @returns {number} Error rate percentage
   * @private
   */
  calculateErrorRate(server) {
    const totalRequests = parseInt(server.stot || 1, 10); // Avoid division by zero
    const errors =
      parseInt(server.econ || 0, 10) +
      parseInt(server.eresp || 0, 10) +
      parseInt(server.dresp || 0, 10);

    return (errors / totalRequests) * 100;
  }

  /**
   * Calculate anomaly thresholds based on metrics history
   * @private
   */
  calculateAnomalyThresholds() {
    // Skip if metrics manager is not available or insufficient history
    if (!this.metricsManager) return;

    // Re-use baseline calculations from metrics manager if available
    if (
      this.metricsManager.baselines &&
      this.metricsManager.baselines.size > 0
    ) {
      // Use existing baselines
      for (const [key, baseline] of this.metricsManager.baselines.entries()) {
        // Only interested in response_time and queue_current
        if (key.includes("response_time") || key.includes("queue_current")) {
          this.anomalyThresholds.set(key, {
            mean: baseline.mean,
            stdDev: baseline.stdDev,
            threshold: baseline.mean + baseline.stdDev * 2.5,
          });
        }
      }

      logger.debug(
        `Used ${this.anomalyThresholds.size} anomaly thresholds from metrics manager baselines`
      );
    } else {
      // No baselines available, use defaults
      logger.debug(
        "No metric baselines available, using default anomaly thresholds"
      );

      // Default thresholds
      this.anomalyThresholds.set("default:response_time", {
        mean: 50,
        stdDev: 20,
        threshold: 100,
      });

      this.anomalyThresholds.set("default:queue_current", {
        mean: 0,
        stdDev: 1,
        threshold: 3,
      });
    }
  }

  /**
   * Get optimization status information
   * @returns {Object} Current optimization status
   */
  getStatus() {
    return {
      initialized: this.initialized,
      isOptimizing: this.isOptimizing,
      lastOptimizationTime: this.lastOptimizationTime
        ? this.lastOptimizationTime.toISOString()
        : null,
      algorithm: this.algorithm,
      adaptationRate: this.adaptationRate,
      enablePredictiveScaling: this.enablePredictiveScaling,
      weights: this.weights,
      backendCount: this.backends.size,
      serverCount: this.serverWeights.size,
      optimizationCount: this.loadHistory.length,
      lastChanges:
        this.weightHistory.length > 0
          ? this.weightHistory[this.weightHistory.length - 1]
          : null,
    };
  }

  /**
   * Get optimization history
   * @param {number} limit - Maximum number of entries to return
   * @returns {Array} Optimization history
   */
  getOptimizationHistory(limit = 10) {
    return this.loadHistory.slice(-limit);
  }

  /**
   * Get weight change history
   * @param {number} limit - Maximum number of entries to return
   * @returns {Array} Weight change history
   */
  getWeightHistory(limit = 10) {
    return this.weightHistory.slice(-limit);
  }

  /**
   * Get backend traffic patterns
   * @param {string} backendName - Backend name
   * @returns {Object} Traffic patterns for the backend
   */
  getBackendTrafficPatterns(backendName) {
    const patterns = this.trafficPatterns.get(backendName);
    if (!patterns) return null;

    return {
      backend: backendName,
      timePatterns: Array.from(patterns.timePatterns.entries()).map(
        ([key, data]) => ({
          timeSlot: key,
          ...data,
        })
      ),
      recentActivity: patterns.recentPatterns,
    };
  }

  /**
   * Force an immediate optimization
   * @param {boolean} emergency - Whether to treat as emergency optimization
   * @returns {Promise<Object>} Optimization result
   */
  async forceOptimization(emergency = false) {
    logger.info(
      `Forcing immediate ${emergency ? "emergency " : ""}optimization`
    );
    return await this.optimizeLoad(emergency);
  }

  /**
   * Update algorithm settings
   * @param {Object} settings - Algorithm settings
   * @returns {boolean} Success
   */
  updateSettings(settings) {
    if (!settings || typeof settings !== "object") return false;

    let changed = false;

    // Update algorithm
    if (
      settings.algorithm &&
      ["adaptive", "predictive", "balanced"].includes(settings.algorithm)
    ) {
      this.algorithm = settings.algorithm;
      changed = true;
    }

    // Update adaptation rate
    if (typeof settings.adaptationRate === "number") {
      this.adaptationRate = Math.min(1, Math.max(0, settings.adaptationRate));
      changed = true;
    }

    // Update predictive scaling setting
    if (typeof settings.enablePredictiveScaling === "boolean") {
      this.enablePredictiveScaling = settings.enablePredictiveScaling;
      changed = true;
    }

    // Update weights
    if (settings.weights && typeof settings.weights === "object") {
      if (typeof settings.weights.performance === "number") {
        this.weights.performance = settings.weights.performance;
        changed = true;
      }

      if (typeof settings.weights.utilization === "number") {
        this.weights.utilization = settings.weights.utilization;
        changed = true;
      }

      if (typeof settings.weights.stability === "number") {
        this.weights.stability = settings.weights.stability;
        changed = true;
      }

      // Normalize weights
      if (changed) {
        const totalWeight =
          this.weights.performance +
          this.weights.utilization +
          this.weights.stability;
        this.weights.performance /= totalWeight;
        this.weights.utilization /= totalWeight;
        this.weights.stability /= totalWeight;
      }
    }

    if (changed) {
      logger.info(
        `Updated optimizer settings: algorithm=${this.algorithm}, adaptationRate=${this.adaptationRate}`
      );
    }

    return changed;
  }

  /**
   * Shutdown the load optimizer
   */
  shutdown() {
    this.stopOptimization();
    logger.info("HAProxy load optimizer shutdown");
  }
}

module.exports = HAProxyLoadOptimizer;
