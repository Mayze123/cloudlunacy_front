/**
 * HAProxy Metrics Manager
 *
 * Advanced performance monitoring and metrics management system for HAProxy:
 * - Collects comprehensive metrics from HAProxy runtime API
 * - Performs trend analysis and anomaly detection
 * - Provides real-time performance insights
 * - Supports metric aggregation and historical data storage
 * - Drives intelligent routing decisions via insights API
 */

const EventEmitter = require("events");
const fs = require("fs").promises;
const path = require("path");
const { withRetry } = require("./retryHandler");
const logger = require("./logger").getLogger("haproxyMetricsManager");

class HAProxyMetricsManager extends EventEmitter {
  /**
   * Create a new HAProxy metrics manager
   * @param {Object} options - Configuration options
   * @param {Object} options.apiClient - HAProxy Data Plane API client
   * @param {Number} options.collectionInterval - Collection interval in ms (default: 10s)
   * @param {Number} options.retentionPeriod - Retention period in ms (default: 24h)
   * @param {Number} options.aggregationInterval - Aggregation interval in ms (default: 1h)
   * @param {Boolean} options.enableStorage - Enable persistent storage (default: true)
   * @param {String} options.storagePath - Path for metrics storage (default: ./data/metrics)
   * @param {Boolean} options.enableAnomalyDetection - Enable anomaly detection (default: true)
   * @param {Number} options.anomalyThreshold - Standard deviations for anomaly (default: 2.5)
   */
  constructor(options = {}) {
    super();

    this.apiClient = options.apiClient;
    this.collectionInterval = options.collectionInterval || 10 * 1000; // 10 seconds
    this.retentionPeriod = options.retentionPeriod || 24 * 60 * 60 * 1000; // 24 hours
    this.aggregationInterval = options.aggregationInterval || 60 * 60 * 1000; // 1 hour
    this.enableStorage = options.enableStorage !== false;
    this.storagePath =
      options.storagePath || path.join(process.cwd(), "data", "metrics");
    this.enableAnomalyDetection = options.enableAnomalyDetection !== false;
    this.anomalyThreshold = options.anomalyThreshold || 2.5;

    // Metrics storage
    this.currentMetrics = {
      timestamp: null,
      haproxy: {
        stats: [],
        info: {},
      },
      system: {
        memory: {},
        cpu: {},
      },
      process: {},
    };

    this.metricsHistory = [];
    this.aggregatedMetrics = [];
    this.baselines = new Map();
    this.anomalies = [];

    // Collection state
    this.collectionTimer = null;
    this.isCollecting = false;
    this.lastCollectionTime = null;
    this.metrics = {};
    this.statusChecks = {};
    this.initialized = false;

    // Performance tracking
    this.perfStats = {
      collectionTimes: [],
      errors: 0,
      lastError: null,
    };

    // Backend and server tracking
    this.backendStats = new Map();
    this.serverStats = new Map();

    // Bind methods
    this.collectMetrics = this.collectMetrics.bind(this);
    this.detectAnomalies = this.detectAnomalies.bind(this);
  }

  /**
   * Initialize the metrics manager
   * @returns {Promise<boolean>} Initialization result
   */
  async initialize() {
    try {
      logger.info("Initializing HAProxy metrics manager");

      // Check if dependencies are available
      if (!this.apiClient) {
        logger.error("API client is required for metrics manager");
        return false;
      }

      // Create storage directory if needed
      if (this.enableStorage) {
        try {
          await fs.mkdir(this.storagePath, { recursive: true });
          logger.info(`Created metrics storage directory: ${this.storagePath}`);
        } catch (mkdirErr) {
          if (mkdirErr.code !== "EEXIST") {
            logger.error(
              `Failed to create metrics storage directory: ${mkdirErr.message}`
            );
            // Continue initialization even if storage directory creation fails
          }
        }

        // Load historic metrics if available
        await this.loadStoredMetrics();
      }

      // Initial baseline calculation
      if (this.metricsHistory.length > 0) {
        this.calculateBaselines();
      }

      // Start metrics collection
      this.startCollection();

      this.initialized = true;
      logger.info("HAProxy metrics manager initialized successfully");
      return true;
    } catch (err) {
      logger.error(`Failed to initialize metrics manager: ${err.message}`);
      return false;
    }
  }

  /**
   * Start periodic metrics collection
   */
  startCollection() {
    if (this.collectionTimer) {
      clearInterval(this.collectionTimer);
    }

    logger.info(
      `Starting metrics collection with interval of ${this.collectionInterval}ms`
    );

    // Start with an immediate collection
    this.collectMetrics().catch((err) => {
      logger.error(`Initial metrics collection failed: ${err.message}`);
    });

    // Schedule regular collections
    this.collectionTimer = setInterval(
      this.collectMetrics,
      this.collectionInterval
    );
  }

  /**
   * Stop metrics collection
   */
  stopCollection() {
    if (this.collectionTimer) {
      clearInterval(this.collectionTimer);
      this.collectionTimer = null;
      logger.info("Metrics collection stopped");
    }
  }

  /**
   * Collect metrics from HAProxy
   * @returns {Promise<Object>} Collected metrics
   */
  async collectMetrics() {
    if (this.isCollecting) {
      logger.debug("Metrics collection already in progress, skipping");
      return this.currentMetrics;
    }

    this.isCollecting = true;
    const startTime = Date.now();

    try {
      // Collect HAProxy stats
      const stats = await this.collectHAProxyStats();

      // Collect HAProxy info
      const info = await this.collectHAProxyInfo();

      // Collect system metrics
      const system = await this.collectSystemMetrics();

      // Collect process metrics
      const process = await this.collectProcessMetrics();

      // Update current metrics
      this.currentMetrics = {
        timestamp: new Date().toISOString(),
        haproxy: {
          stats,
          info,
        },
        system,
        process,
      };

      // Process stats for backend and server tracking
      this.processStats(stats);

      // Add to history
      this.metricsHistory.push({
        timestamp: this.currentMetrics.timestamp,
        data: JSON.parse(JSON.stringify(this.currentMetrics)),
      });

      // Trim history to retention period
      this.trimMetricsHistory();

      // Check for anomalies if enabled
      if (this.enableAnomalyDetection) {
        this.detectAnomalies();
      }

      // Aggregate metrics if needed
      const now = new Date();
      if (
        this.lastAggregationTime === undefined ||
        now - this.lastAggregationTime >= this.aggregationInterval
      ) {
        this.aggregateMetrics();
        this.lastAggregationTime = now;
      }

      // Store metrics if enabled
      if (this.enableStorage) {
        // Store metrics every 5 minutes
        const fiveMinutes = 5 * 60 * 1000;
        if (
          this.lastStorageTime === undefined ||
          now - this.lastStorageTime >= fiveMinutes
        ) {
          this.storeMetrics().catch((err) => {
            logger.error(`Failed to store metrics: ${err.message}`);
          });
          this.lastStorageTime = now;
        }
      }

      // Track collection performance
      const collectionTime = Date.now() - startTime;
      this.perfStats.collectionTimes.push(collectionTime);

      // Limit performance tracking array size
      if (this.perfStats.collectionTimes.length > 100) {
        this.perfStats.collectionTimes.shift();
      }

      this.lastCollectionTime = new Date();

      // Emit metrics collected event
      this.emit("metrics-collected", {
        timestamp: this.currentMetrics.timestamp,
        metricsCount: stats.length,
      });

      logger.debug(`Collected metrics in ${collectionTime}ms`);

      return this.currentMetrics;
    } catch (err) {
      logger.error(`Metrics collection failed: ${err.message}`);

      // Track errors
      this.perfStats.errors++;
      this.perfStats.lastError = {
        timestamp: new Date().toISOString(),
        message: err.message,
      };

      return this.currentMetrics;
    } finally {
      this.isCollecting = false;
    }
  }

  /**
   * Collect HAProxy stats
   * @returns {Promise<Array>} HAProxy stats
   * @private
   */
  async collectHAProxyStats() {
    try {
      const response = await withRetry(
        () => this.apiClient.get("/services/haproxy/stats/native?type=1,2,4,8"),
        { retries: 2, delay: 500 }
      );

      if (response.data && Array.isArray(response.data)) {
        return response.data;
      }

      return [];
    } catch (err) {
      logger.error(`Failed to collect HAProxy stats: ${err.message}`);
      return [];
    }
  }

  /**
   * Collect HAProxy info
   * @returns {Promise<Object>} HAProxy info
   * @private
   */
  async collectHAProxyInfo() {
    try {
      const response = await withRetry(
        () => this.apiClient.get("/services/haproxy/info"),
        { retries: 2, delay: 500 }
      );

      if (response.data && response.data.data) {
        return response.data.data;
      }

      return {};
    } catch (err) {
      logger.error(`Failed to collect HAProxy info: ${err.message}`);
      return {};
    }
  }

  /**
   * Collect system metrics (memory, CPU)
   * @returns {Promise<Object>} System metrics
   * @private
   */
  async collectSystemMetrics() {
    // This is a placeholder for system metrics collection
    // In a real implementation, this would collect from OS APIs
    const metrics = {
      memory: {
        total: 0,
        used: 0,
        free: 0,
        utilization: 0,
      },
      cpu: {
        cores: 0,
        load: 0,
        utilization: 0,
      },
    };

    // If process.memoryUsage and os modules are available, use them
    try {
      const os = require("os");

      // Memory metrics
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;

      metrics.memory.total = totalMem;
      metrics.memory.free = freeMem;
      metrics.memory.used = usedMem;
      metrics.memory.utilization = (usedMem / totalMem) * 100;

      // CPU metrics
      metrics.cpu.cores = os.cpus().length;
      metrics.cpu.load = os.loadavg()[0];
      metrics.cpu.utilization = (metrics.cpu.load / metrics.cpu.cores) * 100;
    } catch (err) {
      logger.warn(`Couldn't collect system metrics: ${err.message}`);
    }

    return metrics;
  }

  /**
   * Collect process metrics
   * @returns {Promise<Object>} Process metrics
   * @private
   */
  async collectProcessMetrics() {
    const metrics = {
      memory: {
        rss: 0,
        heapTotal: 0,
        heapUsed: 0,
        external: 0,
        utilization: 0,
      },
      cpu: {
        user: 0,
        system: 0,
        utilization: 0,
      },
      uptime: 0,
    };

    try {
      // Node.js process memory metrics
      const memoryUsage = process.memoryUsage();
      metrics.memory.rss = memoryUsage.rss;
      metrics.memory.heapTotal = memoryUsage.heapTotal;
      metrics.memory.heapUsed = memoryUsage.heapUsed;
      metrics.memory.external = memoryUsage.external;
      metrics.memory.utilization =
        (memoryUsage.heapUsed / memoryUsage.heapTotal) * 100;

      // Process uptime
      metrics.uptime = process.uptime();

      // CPU usage - in a real implementation, this would use more sophisticated
      // process CPU tracking using OS-specific APIs
      const cpuUsage = process.cpuUsage();
      metrics.cpu.user = cpuUsage.user;
      metrics.cpu.system = cpuUsage.system;

      // Placeholder for CPU utilization - would be more accurate with delta calculations
      metrics.cpu.utilization = 0;
    } catch (err) {
      logger.warn(`Couldn't collect process metrics: ${err.message}`);
    }

    return metrics;
  }

  /**
   * Process stats for backend and server tracking
   * @param {Array} stats - HAProxy stats
   * @private
   */
  processStats(stats) {
    if (!Array.isArray(stats)) return;

    const timestamp = new Date().toISOString();

    // Process backend stats
    const backendStats = stats.filter((stat) => stat.type === "backend");
    for (const backend of backendStats) {
      const name = backend.pxname;

      // Get existing stats or initialize new
      const existing = this.backendStats.get(name) || {
        name,
        history: [],
      };

      // Add latest stats
      existing.history.push({
        timestamp,
        status: backend.status,
        sessions: {
          current: parseInt(backend.scur || 0, 10),
          max: parseInt(backend.smax || 0, 10),
          total: parseInt(backend.stot || 0, 10),
        },
        bytes: {
          in: parseInt(backend.bin || 0, 10),
          out: parseInt(backend.bout || 0, 10),
        },
        errors: {
          connection: parseInt(backend.econ || 0, 10),
          response: parseInt(backend.eresp || 0, 10),
        },
        queue: {
          current: parseInt(backend.qcur || 0, 10),
          max: parseInt(backend.qmax || 0, 10),
        },
        server_up: parseInt(backend.act || 0, 10),
        server_down: parseInt(backend.down || 0, 10),
        response_time: parseInt(backend.rtime || 0, 10),
        connect_time: parseInt(backend.ctime || 0, 10),
        queue_time: parseInt(backend.qtime || 0, 10),
        total_time: parseInt(backend.ttime || 0, 10),
      });

      // Keep history manageable (last 100 data points)
      if (existing.history.length > 100) {
        existing.history.shift();
      }

      // Update backend stats
      this.backendStats.set(name, existing);
    }

    // Process server stats
    const serverStats = stats.filter((stat) => stat.type === "server");
    for (const server of serverStats) {
      const backendName = server.pxname;
      const serverName = server.svname;
      const key = `${backendName}/${serverName}`;

      // Skip BACKEND and FRONTEND entries
      if (serverName === "BACKEND" || serverName === "FRONTEND") continue;

      // Get existing stats or initialize new
      const existing = this.serverStats.get(key) || {
        backend: backendName,
        server: serverName,
        history: [],
      };

      // Add latest stats
      existing.history.push({
        timestamp,
        status: server.status,
        weight: parseInt(server.weight || 0, 10),
        active: server.status === "UP",
        sessions: {
          current: parseInt(server.scur || 0, 10),
          max: parseInt(server.smax || 0, 10),
          total: parseInt(server.stot || 0, 10),
        },
        bytes: {
          in: parseInt(server.bin || 0, 10),
          out: parseInt(server.bout || 0, 10),
        },
        errors: {
          connection: parseInt(server.econ || 0, 10),
          response: parseInt(server.eresp || 0, 10),
        },
        response_time: parseInt(server.rtime || 0, 10),
        connect_time: parseInt(server.ctime || 0, 10),
        queue_time: parseInt(server.qtime || 0, 10),
        total_time: parseInt(server.ttime || 0, 10),
      });

      // Keep history manageable (last 100 data points)
      if (existing.history.length > 100) {
        existing.history.shift();
      }

      // Update server stats
      this.serverStats.set(key, existing);
    }
  }

  /**
   * Detect anomalies in metrics
   * @private
   */
  detectAnomalies() {
    // Need enough history to detect anomalies
    if (this.metricsHistory.length < 10) {
      return [];
    }

    const anomalies = [];
    const latestMetrics = this.currentMetrics;

    try {
      // Check for anomalies in backends
      if (Array.isArray(latestMetrics.haproxy.stats)) {
        for (const stat of latestMetrics.haproxy.stats) {
          if (stat.type !== "backend" && stat.type !== "server") continue;

          const key =
            stat.type === "backend"
              ? stat.pxname
              : `${stat.pxname}/${stat.svname}`;

          // Check metrics that might indicate anomalies
          this.checkMetricAnomaly(
            anomalies,
            key,
            "sessions_current",
            parseInt(stat.scur || 0, 10)
          );
          this.checkMetricAnomaly(
            anomalies,
            key,
            "error_rate",
            this.calculateErrorRate(stat)
          );
          this.checkMetricAnomaly(
            anomalies,
            key,
            "response_time",
            parseInt(stat.rtime || 0, 10)
          );
          this.checkMetricAnomaly(
            anomalies,
            key,
            "queue_current",
            parseInt(stat.qcur || 0, 10)
          );
        }
      }

      // If new anomalies were detected, emit event
      if (anomalies.length > 0) {
        // Add anomalies to the list
        for (const anomaly of anomalies) {
          this.anomalies.push(anomaly);
        }

        // Keep anomaly list manageable
        if (this.anomalies.length > 100) {
          this.anomalies = this.anomalies.slice(-100);
        }

        this.emit("anomalies-detected", {
          timestamp: new Date().toISOString(),
          anomalies,
        });

        logger.info(`Detected ${anomalies.length} anomalies in metrics`);
      }

      return anomalies;
    } catch (err) {
      logger.error(`Anomaly detection failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Check for anomalies in a specific metric
   * @param {Array} anomalies - Array to add anomalies to
   * @param {string} key - Metric key
   * @param {string} metricName - Name of the metric
   * @param {number} currentValue - Current value of the metric
   * @private
   */
  checkMetricAnomaly(anomalies, key, metricName, currentValue) {
    // Get baseline for this metric
    const baselineKey = `${key}:${metricName}`;
    const baseline = this.baselines.get(baselineKey);

    // Skip if no baseline exists
    if (!baseline) return;

    const { mean, stdDev } = baseline;

    // Skip if standard deviation is too small (to avoid noise)
    if (stdDev < 1) return;

    // Calculate z-score (how many standard deviations from mean)
    const zScore = Math.abs((currentValue - mean) / stdDev);

    // Check if value exceeds threshold
    if (zScore >= this.anomalyThreshold) {
      const direction = currentValue > mean ? "high" : "low";
      const severity =
        zScore >= this.anomalyThreshold * 2
          ? "critical"
          : zScore >= this.anomalyThreshold * 1.5
          ? "major"
          : "minor";

      anomalies.push({
        timestamp: new Date().toISOString(),
        target: key,
        metric: metricName,
        value: currentValue,
        baseline: mean,
        zScore,
        direction,
        severity,
        message: `Abnormal ${metricName} for ${key}: ${currentValue} vs baseline ${mean.toFixed(
          2
        )} (${direction}, z=${zScore.toFixed(2)})`,
      });
    }
  }

  /**
   * Calculate error rate for a HAProxy stat
   * @param {Object} stat - HAProxy stat
   * @returns {number} Error rate percentage
   * @private
   */
  calculateErrorRate(stat) {
    const totalRequests = parseInt(stat.stot || 1, 10); // Avoid division by zero
    const errors =
      parseInt(stat.econ || 0, 10) +
      parseInt(stat.eresp || 0, 10) +
      parseInt(stat.dresp || 0, 10);

    return (errors / totalRequests) * 100;
  }

  /**
   * Calculate baselines from historical metrics
   * @private
   */
  calculateBaselines() {
    // Need enough history to calculate baselines
    if (this.metricsHistory.length < 5) {
      return;
    }

    try {
      const metricsByKey = new Map();

      // Collect metrics by key
      for (const { data } of this.metricsHistory) {
        if (!data || !data.haproxy || !Array.isArray(data.haproxy.stats))
          continue;

        for (const stat of data.haproxy.stats) {
          if (stat.type !== "backend" && stat.type !== "server") continue;

          const key =
            stat.type === "backend"
              ? stat.pxname
              : `${stat.pxname}/${stat.svname}`;

          // Track sessions current
          this.addToMetricCollection(
            metricsByKey,
            `${key}:sessions_current`,
            parseInt(stat.scur || 0, 10)
          );

          // Track error rate
          this.addToMetricCollection(
            metricsByKey,
            `${key}:error_rate`,
            this.calculateErrorRate(stat)
          );

          // Track response time
          this.addToMetricCollection(
            metricsByKey,
            `${key}:response_time`,
            parseInt(stat.rtime || 0, 10)
          );

          // Track queue current
          this.addToMetricCollection(
            metricsByKey,
            `${key}:queue_current`,
            parseInt(stat.qcur || 0, 10)
          );
        }
      }

      // Calculate statistics for each metric
      for (const [key, values] of metricsByKey.entries()) {
        // Need enough values for meaningful statistics
        if (values.length < 5) continue;

        // Calculate mean
        const mean = values.reduce((sum, val) => sum + val, 0) / values.length;

        // Calculate standard deviation
        const squareDiffs = values.map((value) => {
          const diff = value - mean;
          return diff * diff;
        });

        const avgSquareDiff =
          squareDiffs.reduce((sum, val) => sum + val, 0) / squareDiffs.length;
        const stdDev = Math.sqrt(avgSquareDiff);

        // Store baseline
        this.baselines.set(key, { mean, stdDev });
      }

      logger.debug(`Calculated baselines for ${this.baselines.size} metrics`);
    } catch (err) {
      logger.error(`Failed to calculate baselines: ${err.message}`);
    }
  }

  /**
   * Add a value to a metric collection
   * @param {Map} metricsByKey - Map of metrics by key
   * @param {string} key - Metric key
   * @param {number} value - Metric value
   * @private
   */
  addToMetricCollection(metricsByKey, key, value) {
    if (!metricsByKey.has(key)) {
      metricsByKey.set(key, []);
    }

    metricsByKey.get(key).push(value);
  }

  /**
   * Trim metrics history to retention period
   * @private
   */
  trimMetricsHistory() {
    if (this.metricsHistory.length === 0) return;

    const cutoffTime = Date.now() - this.retentionPeriod;

    // Filter out metrics older than cutoff time
    this.metricsHistory = this.metricsHistory.filter((entry) => {
      const entryTime = new Date(entry.timestamp).getTime();
      return entryTime >= cutoffTime;
    });
  }

  /**
   * Aggregate metrics for long-term storage
   * @private
   */
  aggregateMetrics() {
    // Need enough metrics to aggregate
    if (this.metricsHistory.length < 5) {
      return;
    }

    try {
      const now = new Date();
      const aggregationPeriod = now.getTime() - this.aggregationInterval;

      // Filter metrics that are in the aggregation period
      const metricsToAggregate = this.metricsHistory.filter((metric) => {
        const metricTime = new Date(metric.timestamp).getTime();
        return metricTime < aggregationPeriod;
      });

      // Skip if not enough metrics to aggregate
      if (metricsToAggregate.length < 3) {
        return;
      }

      // Create an aggregated entry for backends and servers
      const backendMetrics = new Map();
      const serverMetrics = new Map();

      // Process each metric entry for backends and servers
      for (const { data } of metricsToAggregate) {
        if (!data || !data.haproxy || !Array.isArray(data.haproxy.stats))
          continue;

        for (const stat of data.haproxy.stats) {
          if (stat.type === "backend") {
            // Aggregate backend metrics
            this.aggregateBackendMetric(backendMetrics, stat);
          } else if (stat.type === "server") {
            // Skip BACKEND and FRONTEND entries
            if (stat.svname === "BACKEND" || stat.svname === "FRONTEND")
              continue;

            // Aggregate server metrics
            this.aggregateServerMetric(serverMetrics, stat);
          }
        }
      }

      // Create aggregation entry
      const aggregation = {
        timestamp: now.toISOString(),
        period: {
          start: new Date(aggregationPeriod).toISOString(),
          end: now.toISOString(),
        },
        samples: metricsToAggregate.length,
        backends: Array.from(backendMetrics.values()),
        servers: Array.from(serverMetrics.values()),
      };

      // Add to aggregated metrics
      this.aggregatedMetrics.push(aggregation);

      // Keep aggregations manageable (last 24 aggregations = 1 day if hourly)
      if (this.aggregatedMetrics.length > 24) {
        this.aggregatedMetrics.shift();
      }

      logger.info(
        `Aggregated ${metricsToAggregate.length} metrics for ${backendMetrics.size} backends and ${serverMetrics.size} servers`
      );

      // Remove aggregated metrics from history to save memory
      // Keep at least 10 minutes of recent history
      const tenMinutesAgo = now.getTime() - 10 * 60 * 1000;
      this.metricsHistory = this.metricsHistory.filter((metric) => {
        const metricTime = new Date(metric.timestamp).getTime();
        return metricTime >= tenMinutesAgo;
      });

      // If storage is enabled, store the aggregation
      if (this.enableStorage) {
        this.storeAggregation(aggregation).catch((err) => {
          logger.error(`Failed to store aggregation: ${err.message}`);
        });
      }

      // Emit event for aggregation completed
      this.emit("metrics-aggregated", {
        timestamp: now.toISOString(),
        samples: metricsToAggregate.length,
        backends: backendMetrics.size,
        servers: serverMetrics.size,
      });
    } catch (err) {
      logger.error(`Metrics aggregation failed: ${err.message}`);
    }
  }

  /**
   * Aggregate metrics for a backend
   * @param {Map} backendMetrics - Map of backend metrics
   * @param {Object} stat - HAProxy stat
   * @private
   */
  aggregateBackendMetric(backendMetrics, stat) {
    const name = stat.pxname;

    // Get or create backend entry
    if (!backendMetrics.has(name)) {
      backendMetrics.set(name, {
        name,
        status: {
          up: 0,
          down: 0,
        },
        sessions: {
          current: [],
          max: 0,
          total: 0,
        },
        bytes: {
          in: 0,
          out: 0,
        },
        errors: {
          connection: 0,
          response: 0,
        },
        queue: {
          current: [],
          max: 0,
        },
        server_up: [],
        server_down: [],
        response_time: [],
        samples: 0,
      });
    }

    const backend = backendMetrics.get(name);

    // Update status count
    if (stat.status === "UP") {
      backend.status.up++;
    } else {
      backend.status.down++;
    }

    // Update sessions
    backend.sessions.current.push(parseInt(stat.scur || 0, 10));
    backend.sessions.max = Math.max(
      backend.sessions.max,
      parseInt(stat.smax || 0, 10)
    );
    backend.sessions.total += parseInt(stat.stot || 0, 10);

    // Update bytes
    backend.bytes.in += parseInt(stat.bin || 0, 10);
    backend.bytes.out += parseInt(stat.bout || 0, 10);

    // Update errors
    backend.errors.connection += parseInt(stat.econ || 0, 10);
    backend.errors.response += parseInt(stat.eresp || 0, 10);

    // Update queue
    backend.queue.current.push(parseInt(stat.qcur || 0, 10));
    backend.queue.max = Math.max(
      backend.queue.max,
      parseInt(stat.qmax || 0, 10)
    );

    // Update server counts
    backend.server_up.push(parseInt(stat.act || 0, 10));
    backend.server_down.push(parseInt(stat.down || 0, 10));

    // Update response time
    backend.response_time.push(parseInt(stat.rtime || 0, 10));

    // Increment sample count
    backend.samples++;
  }

  /**
   * Aggregate metrics for a server
   * @param {Map} serverMetrics - Map of server metrics
   * @param {Object} stat - HAProxy stat
   * @private
   */
  aggregateServerMetric(serverMetrics, stat) {
    const backendName = stat.pxname;
    const serverName = stat.svname;
    const key = `${backendName}/${serverName}`;

    // Get or create server entry
    if (!serverMetrics.has(key)) {
      serverMetrics.set(key, {
        backend: backendName,
        server: serverName,
        status: {
          up: 0,
          down: 0,
        },
        weight: parseInt(stat.weight || 0, 10),
        sessions: {
          current: [],
          max: 0,
          total: 0,
        },
        bytes: {
          in: 0,
          out: 0,
        },
        errors: {
          connection: 0,
          response: 0,
        },
        response_time: [],
        connect_time: [],
        queue_time: [],
        samples: 0,
      });
    }

    const server = serverMetrics.get(key);

    // Update status count
    if (stat.status === "UP") {
      server.status.up++;
    } else {
      server.status.down++;
    }

    // Update sessions
    server.sessions.current.push(parseInt(stat.scur || 0, 10));
    server.sessions.max = Math.max(
      server.sessions.max,
      parseInt(stat.smax || 0, 10)
    );
    server.sessions.total += parseInt(stat.stot || 0, 10);

    // Update bytes
    server.bytes.in += parseInt(stat.bin || 0, 10);
    server.bytes.out += parseInt(stat.bout || 0, 10);

    // Update errors
    server.errors.connection += parseInt(stat.econ || 0, 10);
    server.errors.response += parseInt(stat.eresp || 0, 10);

    // Update times
    server.response_time.push(parseInt(stat.rtime || 0, 10));
    server.connect_time.push(parseInt(stat.ctime || 0, 10));
    server.queue_time.push(parseInt(stat.qtime || 0, 10));

    // Increment sample count
    server.samples++;
  }

  /**
   * Load stored metrics from disk
   * @returns {Promise<void>}
   * @private
   */
  async loadStoredMetrics() {
    if (!this.enableStorage) return;

    try {
      // Get latest aggregation files
      let files;
      try {
        files = await fs.readdir(this.storagePath);
        files = files.filter(
          (file) => file.startsWith("aggregation-") && file.endsWith(".json")
        );
        files = files.sort().reverse().slice(0, 24); // Get most recent 24 files
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
        files = [];
      }

      // Load each aggregation file
      for (const file of files) {
        try {
          const filePath = path.join(this.storagePath, file);
          const content = await fs.readFile(filePath, "utf8");
          const aggregation = JSON.parse(content);

          this.aggregatedMetrics.push(aggregation);
        } catch (err) {
          logger.warn(
            `Failed to load aggregation file ${file}: ${err.message}`
          );
        }
      }

      // Sort aggregations by timestamp
      this.aggregatedMetrics.sort(
        (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
      );

      logger.info(
        `Loaded ${this.aggregatedMetrics.length} stored metric aggregations`
      );

      // If available, use most recent aggregations to seed baselines
      if (this.aggregatedMetrics.length > 0) {
        this.calculateBaselinesFromAggregations();
      }
    } catch (err) {
      logger.error(`Failed to load stored metrics: ${err.message}`);
    }
  }

  /**
   * Store current metrics to disk
   * @returns {Promise<void>}
   * @private
   */
  async storeMetrics() {
    if (!this.enableStorage || !this.currentMetrics.timestamp) return;

    try {
      // Format timestamp for filename
      const timestamp = this.currentMetrics.timestamp.replace(/[:.]/g, "-");
      const filename = `metrics-${timestamp}.json`;
      const filePath = path.join(this.storagePath, filename);

      // Write metrics to file
      await fs.writeFile(filePath, JSON.stringify(this.currentMetrics), "utf8");

      logger.debug(`Stored metrics to ${filePath}`);
    } catch (err) {
      logger.error(`Failed to store metrics: ${err.message}`);
    }
  }

  /**
   * Store an aggregation to disk
   * @param {Object} aggregation - Metrics aggregation
   * @returns {Promise<void>}
   * @private
   */
  async storeAggregation(aggregation) {
    if (!this.enableStorage) return;

    try {
      // Format timestamp for filename
      const timestamp = aggregation.timestamp.replace(/[:.]/g, "-");
      const filename = `aggregation-${timestamp}.json`;
      const filePath = path.join(this.storagePath, filename);

      // Write aggregation to file
      await fs.writeFile(filePath, JSON.stringify(aggregation), "utf8");

      logger.debug(`Stored aggregation to ${filePath}`);
    } catch (err) {
      logger.error(`Failed to store aggregation: ${err.message}`);
    }
  }

  /**
   * Calculate baselines from stored aggregations
   * @private
   */
  calculateBaselinesFromAggregations() {
    if (this.aggregatedMetrics.length === 0) return;

    try {
      logger.info("Calculating baselines from stored aggregations");

      // Process backend metrics
      for (const aggregation of this.aggregatedMetrics) {
        // Process backend metrics
        for (const backend of aggregation.backends) {
          // Calculate averages from arrays
          const avgSessions = this.calculateAverage(backend.sessions.current);
          const avgQueueCurrent = this.calculateAverage(backend.queue.current);
          const avgServerUp = this.calculateAverage(backend.server_up);
          const avgServerDown = this.calculateAverage(backend.server_down);
          const avgResponseTime = this.calculateAverage(backend.response_time);

          // Add to baseline calculations
          this.addToMetricCollection(
            this.backendBaselines,
            `${backend.name}:sessions_current`,
            avgSessions
          );

          this.addToMetricCollection(
            this.backendBaselines,
            `${backend.name}:queue_current`,
            avgQueueCurrent
          );

          this.addToMetricCollection(
            this.backendBaselines,
            `${backend.name}:server_up`,
            avgServerUp
          );

          this.addToMetricCollection(
            this.backendBaselines,
            `${backend.name}:server_down`,
            avgServerDown
          );

          this.addToMetricCollection(
            this.backendBaselines,
            `${backend.name}:response_time`,
            avgResponseTime
          );
        }

        // Process server metrics
        for (const server of aggregation.servers) {
          const key = `${server.backend}/${server.server}`;

          // Calculate averages from arrays
          const avgSessions = this.calculateAverage(server.sessions.current);
          const avgResponseTime = this.calculateAverage(server.response_time);
          const avgConnectTime = this.calculateAverage(server.connect_time);
          const avgQueueTime = this.calculateAverage(server.queue_time);

          // Add to baseline calculations
          this.addToMetricCollection(
            this.serverBaselines,
            `${key}:sessions_current`,
            avgSessions
          );

          this.addToMetricCollection(
            this.serverBaselines,
            `${key}:response_time`,
            avgResponseTime
          );

          this.addToMetricCollection(
            this.serverBaselines,
            `${key}:connect_time`,
            avgConnectTime
          );

          this.addToMetricCollection(
            this.serverBaselines,
            `${key}:queue_time`,
            avgQueueTime
          );
        }
      }

      // Calculate baselines from collected values
      this.calculateBaselineStats();

      logger.info(
        `Calculated ${this.baselines.size} baselines from aggregations`
      );
    } catch (err) {
      logger.error(
        `Failed to calculate baselines from aggregations: ${err.message}`
      );
    }
  }

  /**
   * Calculate average of an array of numbers
   * @param {Array} values - Array of numbers
   * @returns {number} Average value
   * @private
   */
  calculateAverage(values) {
    if (!Array.isArray(values) || values.length === 0) return 0;
    return values.reduce((sum, val) => sum + val, 0) / values.length;
  }

  /**
   * Get current metrics
   * @returns {Object} Current metrics
   */
  getCurrentMetrics() {
    return this.currentMetrics;
  }

  /**
   * Get metrics for a specific backend
   * @param {string} backendName - Backend name
   * @returns {Object|null} Backend metrics
   */
  getBackendMetrics(backendName) {
    return this.backendStats.get(backendName) || null;
  }

  /**
   * Get metrics for a specific server
   * @param {string} backendName - Backend name
   * @param {string} serverName - Server name
   * @returns {Object|null} Server metrics
   */
  getServerMetrics(backendName, serverName) {
    return this.serverStats.get(`${backendName}/${serverName}`) || null;
  }

  /**
   * Get all backend metrics
   * @returns {Array} Backend metrics
   */
  getAllBackendMetrics() {
    return Array.from(this.backendStats.values());
  }

  /**
   * Get all server metrics
   * @returns {Array} Server metrics
   */
  getAllServerMetrics() {
    return Array.from(this.serverStats.values());
  }

  /**
   * Get detected anomalies
   * @param {number} limit - Maximum number of anomalies to return
   * @returns {Array} Detected anomalies
   */
  getAnomalies(limit = 20) {
    return this.anomalies.slice(-limit);
  }

  /**
   * Get metrics history
   * @param {number} limit - Maximum number of history entries
   * @returns {Array} Metrics history
   */
  getMetricsHistory(limit = 20) {
    return this.metricsHistory.slice(-limit).map((entry) => ({
      timestamp: entry.timestamp,
      data: entry.data,
    }));
  }

  /**
   * Get aggregated metrics
   * @returns {Array} Aggregated metrics
   */
  getAggregatedMetrics() {
    return this.aggregatedMetrics;
  }

  /**
   * Get performance insights based on current metrics
   * @returns {Object} Performance insights
   */
  getPerformanceInsights() {
    const insights = {
      timestamp: new Date().toISOString(),
      overall: {
        status: "normal",
        score: 100,
      },
      backends: [],
      anomalies: this.getAnomalies(5),
      recommendations: [],
    };

    try {
      // Calculate overall status based on backends
      let backendIssues = 0;

      // Process all backends
      for (const [name, stats] of this.backendStats.entries()) {
        if (!stats.history || stats.history.length === 0) continue;

        const latest = stats.history[stats.history.length - 1];

        // Skip if backend has no recent data
        if (!latest) continue;

        // Calculate backend health
        const healthScore = this.calculateBackendHealthScore(name, latest);

        // Add to insights
        insights.backends.push({
          name,
          health: healthScore.health,
          score: healthScore.score,
          status: latest.status,
          sessions: latest.sessions,
          responseTime: latest.response_time,
          queuedRequests: latest.queue.current,
          activeServers: latest.server_up,
          issues: healthScore.issues,
        });

        // Count backend issues
        if (healthScore.health !== "healthy") {
          backendIssues++;
        }
      }

      // Calculate overall status
      if (backendIssues > 0) {
        const percentageIssues =
          (backendIssues / Math.max(1, insights.backends.length)) * 100;

        if (percentageIssues > 50) {
          insights.overall.status = "critical";
          insights.overall.score = Math.max(0, 100 - percentageIssues);
        } else if (percentageIssues > 25) {
          insights.overall.status = "warning";
          insights.overall.score = Math.max(50, 100 - percentageIssues);
        } else {
          insights.overall.status = "degraded";
          insights.overall.score = Math.max(75, 100 - percentageIssues);
        }
      }

      // Generate recommendations
      insights.recommendations = this.generateRecommendations(insights);

      return insights;
    } catch (err) {
      logger.error(`Failed to generate performance insights: ${err.message}`);

      return {
        timestamp: new Date().toISOString(),
        overall: {
          status: "unknown",
          score: 0,
        },
        backends: [],
        anomalies: [],
        recommendations: [
          {
            type: "error",
            message: `Failed to generate insights: ${err.message}`,
            priority: "high",
          },
        ],
      };
    }
  }

  /**
   * Calculate health score for a backend
   * @param {string} name - Backend name
   * @param {Object} latest - Latest metrics
   * @returns {Object} Health score
   * @private
   */
  calculateBackendHealthScore(name, latest) {
    const issues = [];
    let score = 100;

    // Check status
    if (latest.status !== "UP") {
      issues.push({
        type: "status",
        message: `Backend ${name} status is ${latest.status}`,
        severity: "critical",
      });
      score -= 50;
    }

    // Check if any servers are down
    if (latest.server_down > 0) {
      issues.push({
        type: "servers_down",
        message: `Backend ${name} has ${latest.server_down} servers down`,
        severity:
          latest.server_down >= latest.server_up ? "critical" : "warning",
      });
      score -=
        (latest.server_down / (latest.server_up + latest.server_down)) * 50;
    }

    // Check queue size
    if (latest.queue.current > 0) {
      const severity =
        latest.queue.current > 10
          ? "critical"
          : latest.queue.current > 5
          ? "warning"
          : "info";

      issues.push({
        type: "queue",
        message: `Backend ${name} has ${latest.queue.current} requests in queue`,
        severity,
      });

      // Score penalty based on queue size
      score -= Math.min(30, latest.queue.current * 3);
    }

    // Check error rates
    const totalRequests = latest.sessions.total;
    if (totalRequests > 0) {
      const errorRate =
        ((latest.errors.connection + latest.errors.response) / totalRequests) *
        100;

      if (errorRate > 1) {
        const severity =
          errorRate > 10 ? "critical" : errorRate > 5 ? "warning" : "info";

        issues.push({
          type: "error_rate",
          message: `Backend ${name} has ${errorRate.toFixed(2)}% error rate`,
          severity,
        });

        // Score penalty based on error rate
        score -= Math.min(40, errorRate * 4);
      }
    }

    // Determine health category
    let health = "healthy";
    if (score < 50) {
      health = "critical";
    } else if (score < 70) {
      health = "warning";
    } else if (score < 90) {
      health = "degraded";
    }

    return {
      health,
      score: Math.max(0, Math.min(100, Math.round(score))),
      issues,
    };
  }

  /**
   * Generate recommendations based on insights
   * @param {Object} insights - Performance insights
   * @returns {Array} Recommendations
   * @private
   */
  generateRecommendations(insights) {
    const recommendations = [];

    try {
      // Check overall status
      if (insights.overall.status !== "normal") {
        recommendations.push({
          type: "overall",
          message: `System status is ${insights.overall.status} with a health score of ${insights.overall.score}/100`,
          priority:
            insights.overall.status === "critical" ? "critical" : "high",
        });
      }

      // Check each backend
      for (const backend of insights.backends) {
        if (backend.health !== "healthy") {
          // Check queue issues
          if (backend.queuedRequests > 0) {
            recommendations.push({
              type: "queue",
              message: `Reduce queue size for ${backend.name} (${backend.queuedRequests} requests queued)`,
              priority: backend.queuedRequests > 10 ? "critical" : "high",
              actions: [
                "Increase server capacity",
                "Optimize request processing",
                "Implement request throttling",
              ],
            });
          }

          // Check for server issues
          if (backend.issues.some((issue) => issue.type === "servers_down")) {
            recommendations.push({
              type: "servers",
              message: `Restore downed servers for ${backend.name}`,
              priority: "high",
              actions: [
                "Investigate server failures",
                "Restart troubled servers",
                "Replace malfunctioning servers",
              ],
            });
          }

          // Check for error rate issues
          if (backend.issues.some((issue) => issue.type === "error_rate")) {
            recommendations.push({
              type: "errors",
              message: `Investigate error rate issues for ${backend.name}`,
              priority: "high",
              actions: [
                "Check server logs for errors",
                "Verify application health",
                "Test backend connectivity",
              ],
            });
          }
        }
      }

      // Check for anomalies
      if (insights.anomalies && insights.anomalies.length > 0) {
        const criticalAnomalies = insights.anomalies.filter(
          (a) => a.severity === "critical"
        );

        if (criticalAnomalies.length > 0) {
          recommendations.push({
            type: "anomalies",
            message: `Address ${criticalAnomalies.length} critical metric anomalies`,
            priority: "critical",
            actions: criticalAnomalies.map(
              (a) => `Investigate ${a.metric} for ${a.target}`
            ),
          });
        }
      }

      return recommendations;
    } catch (err) {
      logger.error(`Failed to generate recommendations: ${err.message}`);
      return [
        {
          type: "error",
          message: `Failed to generate recommendations: ${err.message}`,
          priority: "high",
        },
      ];
    }
  }

  /**
   * Shutdown the metrics manager
   */
  shutdown() {
    this.stopCollection();

    // Save any pending metrics
    if (this.enableStorage && this.currentMetrics.timestamp) {
      this.storeMetrics().catch((err) => {
        logger.error(`Failed to store metrics during shutdown: ${err.message}`);
      });
    }

    logger.info("HAProxy metrics manager shutdown");
  }
}

module.exports = HAProxyMetricsManager;
