/**
 * HAProxy Metrics Collector
 *
 * This module collects and processes performance metrics from HAProxy through the Data Plane API
 * and provides aggregated metrics for monitoring and optimization purposes.
 */

const EventEmitter = require("events");
const logger = require("./logger").getLogger("haproxyMetricsCollector");
const { withRetry } = require("./retryHandler");
const fs = require("fs").promises;
const path = require("path");

class HAProxyMetricsCollector extends EventEmitter {
  /**
   * Create a new HAProxy metrics collector
   * @param {Object} options - Configuration options
   * @param {Object} options.apiClient - HAProxy Data Plane API client
   * @param {Number} options.interval - Metrics collection interval in ms (default: 10s)
   * @param {Number} options.historySize - Number of historical data points to keep (default: 60)
   * @param {Boolean} options.enableProcessMetrics - Collect HAProxy process metrics (default: true)
   * @param {Boolean} options.persistMetrics - Save metrics to disk for historical analysis (default: false)
   */
  constructor(options = {}) {
    super();

    this.apiClient = options.apiClient;
    this.interval = options.interval || 10 * 1000; // 10 seconds
    this.historySize = options.historySize || 60; // 60 data points = 10 minutes @ 10s interval
    this.enableProcessMetrics =
      options.enableProcessMetrics !== undefined
        ? options.enableProcessMetrics
        : true;
    this.persistMetrics = options.persistMetrics || false;

    // Metrics state
    this.collectionTimer = null;
    this.isCollecting = false;
    this.lastCollectionTime = null;
    this.startTime = new Date();

    // Current metrics snapshot
    this.currentMetrics = {
      timestamp: null,
      haproxy: {
        version: null,
        uptime: null,
        stats: [],
      },
      process: {
        cpu: {
          utilization: null,
        },
        memory: {
          used: null,
          utilization: null,
        },
      },
      summary: {
        totalConnections: 0,
        currentConnections: 0,
        requestRate: 0,
        errorRate: 0,
        averageResponseTime: 0,
      },
    };

    // Historical metrics
    this.metricsHistory = [];

    // Backend-specific history
    this.backendHistory = new Map();

    // Server-specific history
    this.serverHistory = new Map();

    // Advanced analytics
    this.alertThresholds = {
      errorRate: 5, // 5% error rate
      responseTime: 1000, // 1000ms response time
      queueSize: 10, // 10 connections in queue
    };

    // Traffic pattern analysis
    this.trafficPatterns = {
      hourly: new Array(24)
        .fill()
        .map(() => ({ connections: 0, requests: 0, samples: 0 })),
      daily: new Array(7)
        .fill()
        .map(() => ({ connections: 0, requests: 0, samples: 0 })),
    };

    // Persistent storage options
    this.metricsStoragePath = path.join(process.cwd(), "data", "metrics");
    this.lastPersistTime = null;
    this.persistInterval = 60 * 60 * 1000; // 1 hour

    // Bind methods
    this.collectMetrics = this.collectMetrics.bind(this);
  }

  /**
   * Initialize the metrics collector
   * @returns {Promise<boolean>} Initialization success
   */
  async initialize() {
    try {
      logger.info("Initializing HAProxy metrics collector");

      // Check dependencies
      if (!this.apiClient) {
        logger.error("API client is required for the metrics collector");
        return false;
      }

      // Create data directory if needed
      if (this.persistMetrics) {
        try {
          await fs.mkdir(this.metricsStoragePath, { recursive: true });
          logger.info(
            `Created metrics storage directory at ${this.metricsStoragePath}`
          );
        } catch (err) {
          if (err.code !== "EEXIST") {
            logger.error(
              `Failed to create metrics storage directory: ${err.message}`
            );
            this.persistMetrics = false;
          }
        }

        // Try to load historical traffic patterns
        await this.loadTrafficPatterns();
      }

      // Collect initial metrics
      await this.collectMetrics();

      // Start the collection interval
      this.startCollection();

      logger.info("HAProxy metrics collector initialized successfully");
      return true;
    } catch (err) {
      logger.error(
        `Failed to initialize HAProxy metrics collector: ${err.message}`
      );
      return false;
    }
  }

  /**
   * Start metrics collection at the configured interval
   */
  startCollection() {
    if (this.collectionTimer) {
      clearInterval(this.collectionTimer);
    }

    logger.info(`Starting metrics collection every ${this.interval / 1000}s`);
    this.collectionTimer = setInterval(this.collectMetrics, this.interval);
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
   * Collect current metrics from HAProxy
   * @returns {Promise<Object>} Collected metrics
   */
  async collectMetrics() {
    if (this.isCollecting) {
      logger.debug("Metrics collection already in progress, skipping");
      return this.currentMetrics;
    }

    this.isCollecting = true;
    const collectionStart = Date.now();

    try {
      const timestamp = new Date();

      // Fetch HAProxy stats
      const stats = await this.getHAProxyStats();

      // Fetch HAProxy info (if available)
      const info = await this.getHAProxyInfo().catch(() => null);

      // Fetch HAProxy process metrics if enabled
      let processMetrics = null;
      if (this.enableProcessMetrics) {
        processMetrics = await this.getProcessMetrics().catch(() => null);
      }

      // Calculate summary metrics
      const summary = this.calculateSummaryMetrics(stats);

      // Update current metrics
      this.currentMetrics = {
        timestamp: timestamp.toISOString(),
        haproxy: {
          version: info ? info.version : null,
          uptime: info ? info.uptime : null,
          stats: stats,
        },
        process: processMetrics || {
          cpu: { utilization: null },
          memory: { used: null, utilization: null },
        },
        summary,
      };

      // Update traffic patterns
      this.updateTrafficPatterns(timestamp, summary);

      // Update metrics history
      this.updateMetricsHistory(this.currentMetrics);

      // Persist metrics if enabled and due
      if (
        this.persistMetrics &&
        (!this.lastPersistTime ||
          Date.now() - this.lastPersistTime >= this.persistInterval)
      ) {
        this.persistMetricsToStorage().catch((err) => {
          logger.error(`Failed to persist metrics: ${err.message}`);
        });
        this.lastPersistTime = Date.now();
      }

      // Calculate collection duration
      const collectionTime = Date.now() - collectionStart;

      // If collection is slow, log a warning
      if (collectionTime > 1000) {
        logger.warn(
          `Metrics collection took ${collectionTime}ms which is unusually long`
        );
      }

      // Emit metrics update event
      this.emit("metrics-updated", {
        timestamp: timestamp.toISOString(),
        metrics: this.currentMetrics,
        collectionTime,
      });

      return this.currentMetrics;
    } catch (err) {
      logger.error(`Failed to collect metrics: ${err.message}`);
      return this.currentMetrics;
    } finally {
      this.lastCollectionTime = Date.now();
      this.isCollecting = false;
    }
  }

  /**
   * Get HAProxy stats from the Data Plane API
   * @returns {Promise<Array>} HAProxy stats
   * @private
   */
  async getHAProxyStats() {
    try {
      const response = await withRetry(
        () => this.apiClient.get("/services/haproxy/stats/native"),
        { retries: 3, delay: 500 }
      );

      if (response && response.data && response.data.data) {
        return response.data.data;
      }

      return [];
    } catch (err) {
      logger.error(`Failed to get HAProxy stats: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get HAProxy information from the Data Plane API
   * @returns {Promise<Object>} HAProxy info
   * @private
   */
  async getHAProxyInfo() {
    try {
      const response = await withRetry(
        () => this.apiClient.get("/services/haproxy/info"),
        { retries: 2, delay: 500 }
      );

      if (response && response.data && response.data.data) {
        return response.data.data;
      }

      return null;
    } catch (err) {
      logger.debug(`Failed to get HAProxy info: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get HAProxy process metrics
   * @returns {Promise<Object>} Process metrics
   * @private
   */
  async getProcessMetrics() {
    try {
      const response = await withRetry(
        () => this.apiClient.get("/services/haproxy/runtime/process_info"),
        { retries: 2, delay: 500 }
      );

      if (response && response.data && response.data.data) {
        const processInfo = response.data.data;

        return {
          cpu: {
            utilization: processInfo.cpu_usage_percent || null,
          },
          memory: {
            used: processInfo.mem_used || null,
            utilization: processInfo.mem_usage_percent || null,
          },
        };
      }

      return null;
    } catch (err) {
      logger.debug(`Failed to get process metrics: ${err.message}`);
      throw err;
    }
  }

  /**
   * Calculate summary metrics from HAProxy stats
   * @param {Array} stats - HAProxy stats
   * @returns {Object} Summary metrics
   * @private
   */
  calculateSummaryMetrics(stats) {
    let totalConnections = 0;
    let currentConnections = 0;
    let totalRequests = 0;
    let errorResponses = 0;
    let totalRequests1m = 0;
    let totalResponseTime = 0;
    let responseTimeSamples = 0;

    // Process all stats
    for (const stat of stats) {
      // Skip entries without a type
      if (!stat.type) continue;

      // Front-end connections
      if (stat.type === "frontend") {
        const statConnections = parseInt(stat.stot || 0, 10);
        totalConnections += statConnections;
        currentConnections += parseInt(stat.scur || 0, 10);

        // Track requests if available
        if (stat.req_tot) {
          const statRequests = parseInt(stat.req_tot, 10);
          totalRequests += statRequests;
        }

        // Track request rate
        if (stat.req_rate) {
          totalRequests1m += parseInt(stat.req_rate, 10);
        }
      }

      // Back-end error responses
      if (stat.type === "backend") {
        // Add up 4xx and 5xx responses
        const errors4xx = parseInt(stat.hrsp_4xx || 0, 10);
        const errors5xx = parseInt(stat.hrsp_5xx || 0, 10);
        errorResponses += errors4xx + errors5xx;
      }

      // Server response times
      if (stat.type === "server" && stat.ttime) {
        const responseTime = parseInt(stat.ttime, 10);
        if (responseTime > 0) {
          totalResponseTime += responseTime;
          responseTimeSamples++;
        }
      }
    }

    // Calculate derived metrics
    const averageResponseTime =
      responseTimeSamples > 0 ? totalResponseTime / responseTimeSamples : 0;

    const errorRate =
      totalRequests > 0 ? (errorResponses / totalRequests) * 100 : 0;

    return {
      totalConnections,
      currentConnections,
      requestRate: totalRequests1m,
      totalRequests,
      errorResponses,
      errorRate,
      averageResponseTime,
    };
  }

  /**
   * Update traffic patterns based on current metrics
   * @param {Date} timestamp - Collection timestamp
   * @param {Object} summary - Summary metrics
   * @private
   */
  updateTrafficPatterns(timestamp, summary) {
    const hour = timestamp.getHours();
    const day = timestamp.getDay();

    // Update hourly pattern
    const hourlyPattern = this.trafficPatterns.hourly[hour];
    hourlyPattern.connections =
      (hourlyPattern.connections * hourlyPattern.samples +
        summary.currentConnections) /
      (hourlyPattern.samples + 1);

    hourlyPattern.requests =
      (hourlyPattern.requests * hourlyPattern.samples + summary.requestRate) /
      (hourlyPattern.samples + 1);

    hourlyPattern.samples++;

    // Update daily pattern
    const dailyPattern = this.trafficPatterns.daily[day];
    dailyPattern.connections =
      (dailyPattern.connections * dailyPattern.samples +
        summary.currentConnections) /
      (dailyPattern.samples + 1);

    dailyPattern.requests =
      (dailyPattern.requests * dailyPattern.samples + summary.requestRate) /
      (dailyPattern.samples + 1);

    dailyPattern.samples++;
  }

  /**
   * Update metrics history
   * @param {Object} metrics - Current metrics
   * @private
   */
  updateMetricsHistory(metrics) {
    // Add to global metrics history
    this.metricsHistory.push({
      timestamp: metrics.timestamp,
      summary: { ...metrics.summary },
      process: {
        cpu: { ...metrics.process.cpu },
        memory: { ...metrics.process.memory },
      },
    });

    // Trim history to desired size
    if (this.metricsHistory.length > this.historySize) {
      this.metricsHistory.shift();
    }

    // Update backend-specific history
    const backendStats = metrics.haproxy.stats.filter(
      (stat) => stat.type === "backend"
    );
    for (const backend of backendStats) {
      const backendName = backend.name;

      if (!this.backendHistory.has(backendName)) {
        this.backendHistory.set(backendName, []);
      }

      const history = this.backendHistory.get(backendName);

      // Add new data point
      history.push({
        timestamp: metrics.timestamp,
        status: backend.status,
        currentConn: parseInt(backend.scur || 0, 10),
        totalConn: parseInt(backend.stot || 0, 10),
        requestRate: parseInt(backend.req_rate || 0, 10),
        responseTime: parseInt(backend.ttime || 0, 10),
        errors: {
          connection: parseInt(backend.econ || 0, 10),
          response: parseInt(backend.eresp || 0, 10),
          "4xx": parseInt(backend.hrsp_4xx || 0, 10),
          "5xx": parseInt(backend.hrsp_5xx || 0, 10),
        },
        queue: {
          current: parseInt(backend.qcur || 0, 10),
          max: parseInt(backend.qmax || 0, 10),
        },
      });

      // Trim history
      if (history.length > this.historySize) {
        history.shift();
      }
    }

    // Update server-specific history
    const serverStats = metrics.haproxy.stats.filter(
      (stat) =>
        stat.type === "server" &&
        stat.svname !== "BACKEND" &&
        stat.svname !== "FRONTEND"
    );

    for (const server of serverStats) {
      const serverKey = `${server.pxname}/${server.svname}`;

      if (!this.serverHistory.has(serverKey)) {
        this.serverHistory.set(serverKey, []);
      }

      const history = this.serverHistory.get(serverKey);

      // Add new data point
      history.push({
        timestamp: metrics.timestamp,
        status: server.status,
        weight: parseInt(server.weight || 100, 10),
        currentConn: parseInt(server.scur || 0, 10),
        totalConn: parseInt(server.stot || 0, 10),
        responseTime: parseInt(server.ttime || 0, 10),
        errors: {
          connection: parseInt(server.econ || 0, 10),
          response: parseInt(server.eresp || 0, 10),
        },
      });

      // Trim history
      if (history.length > this.historySize) {
        history.shift();
      }
    }
  }

  /**
   * Persist metrics to storage
   * @returns {Promise<void>}
   * @private
   */
  async persistMetricsToStorage() {
    try {
      if (!this.persistMetrics) return;

      const now = new Date();
      const dateStr = now.toISOString().split("T")[0]; // YYYY-MM-DD
      const filename = `metrics-${dateStr}.json`;
      const filePath = path.join(this.metricsStoragePath, filename);

      // Prepare summary for today
      const summaryData = {
        date: dateStr,
        timestamp: now.toISOString(),
        metrics: {
          summary: { ...this.currentMetrics.summary },
          trafficPatterns: {
            hourly: [...this.trafficPatterns.hourly],
            daily: [...this.trafficPatterns.daily],
          },
        },
      };

      // Check if file exists and append, or create new
      let existingData = [];
      try {
        const fileContent = await fs.readFile(filePath, "utf8");
        existingData = JSON.parse(fileContent);

        if (!Array.isArray(existingData)) {
          existingData = [existingData];
        }
      } catch (err) {
        if (err.code !== "ENOENT") {
          logger.error(`Error reading metrics file: ${err.message}`);
        }
        // File doesn't exist, use empty array
      }

      // Add new data and save
      existingData.push(summaryData);

      await fs.writeFile(filePath, JSON.stringify(existingData), "utf8");

      // Also save traffic patterns separately for easier loading
      await this.saveTrafficPatterns();

      logger.debug(`Persisted metrics to ${filePath}`);
    } catch (err) {
      logger.error(`Failed to persist metrics: ${err.message}`);
    }
  }

  /**
   * Save traffic patterns to a separate file
   * @returns {Promise<void>}
   * @private
   */
  async saveTrafficPatterns() {
    try {
      const patternsPath = path.join(
        this.metricsStoragePath,
        "traffic-patterns.json"
      );

      await fs.writeFile(
        patternsPath,
        JSON.stringify(this.trafficPatterns),
        "utf8"
      );
    } catch (err) {
      logger.error(`Failed to save traffic patterns: ${err.message}`);
    }
  }

  /**
   * Load traffic patterns from storage
   * @returns {Promise<void>}
   * @private
   */
  async loadTrafficPatterns() {
    try {
      const patternsPath = path.join(
        this.metricsStoragePath,
        "traffic-patterns.json"
      );

      try {
        const data = await fs.readFile(patternsPath, "utf8");
        const patterns = JSON.parse(data);

        // Validate format
        if (
          patterns &&
          Array.isArray(patterns.hourly) &&
          patterns.hourly.length === 24 &&
          Array.isArray(patterns.daily) &&
          patterns.daily.length === 7
        ) {
          this.trafficPatterns = patterns;
          logger.info("Loaded historical traffic patterns");
        }
      } catch (err) {
        if (err.code !== "ENOENT") {
          logger.warn(`Error reading traffic patterns: ${err.message}`);
        }
      }
    } catch (err) {
      logger.error(`Failed to load traffic patterns: ${err.message}`);
    }
  }

  /**
   * Get current metrics
   * @returns {Object} Current metrics
   */
  getCurrentMetrics() {
    return {
      ...this.currentMetrics,
      collectorUptime: Math.floor((Date.now() - this.startTime) / 1000),
    };
  }

  /**
   * Get metrics history
   * @param {number} limit - Maximum number of history entries
   * @returns {Array} Metrics history
   */
  getMetricsHistory(limit = null) {
    const history = [...this.metricsHistory];
    if (limit && limit > 0 && limit < history.length) {
      return history.slice(-limit);
    }
    return history;
  }

  /**
   * Get backend metrics history
   * @param {string} backendName - Backend name
   * @param {number} limit - Maximum number of history entries
   * @returns {Array} Backend metrics history
   */
  getBackendHistory(backendName, limit = null) {
    if (!this.backendHistory.has(backendName)) {
      return [];
    }

    const history = [...this.backendHistory.get(backendName)];
    if (limit && limit > 0 && limit < history.length) {
      return history.slice(-limit);
    }
    return history;
  }

  /**
   * Get server metrics history
   * @param {string} backendName - Backend name
   * @param {string} serverName - Server name
   * @param {number} limit - Maximum number of history entries
   * @returns {Array} Server metrics history
   */
  getServerHistory(backendName, serverName, limit = null) {
    const serverKey = `${backendName}/${serverName}`;

    if (!this.serverHistory.has(serverKey)) {
      return [];
    }

    const history = [...this.serverHistory.get(serverKey)];
    if (limit && limit > 0 && limit < history.length) {
      return history.slice(-limit);
    }
    return history;
  }

  /**
   * Get traffic patterns
   * @returns {Object} Traffic patterns
   */
  getTrafficPatterns() {
    return {
      hourly: [...this.trafficPatterns.hourly],
      daily: [...this.trafficPatterns.daily],
      peakHour: this.calculatePeakTrafficPeriod("hourly"),
      peakDay: this.calculatePeakTrafficPeriod("daily"),
    };
  }

  /**
   * Calculate peak traffic period
   * @param {string} type - Type of pattern ('hourly' or 'daily')
   * @returns {Object} Peak period information
   * @private
   */
  calculatePeakTrafficPeriod(type) {
    if (type !== "hourly" && type !== "daily") {
      return null;
    }

    const patterns = this.trafficPatterns[type];
    let peakIndex = 0;
    let peakValue = 0;

    for (let i = 0; i < patterns.length; i++) {
      // Only consider periods with samples
      if (patterns[i].samples > 0) {
        // Use connections as the metric for peak calculation
        if (patterns[i].connections > peakValue) {
          peakValue = patterns[i].connections;
          peakIndex = i;
        }
      }
    }

    return {
      index: peakIndex,
      value: peakValue,
      label:
        type === "hourly"
          ? `${peakIndex}:00 - ${peakIndex + 1}:00`
          : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][peakIndex],
    };
  }

  /**
   * Set alert thresholds
   * @param {Object} thresholds - Alert thresholds
   */
  setAlertThresholds(thresholds) {
    if (!thresholds) return;

    Object.keys(thresholds).forEach((key) => {
      if (this.alertThresholds.hasOwnProperty(key)) {
        this.alertThresholds[key] = thresholds[key];
        logger.info(`Set ${key} alert threshold to ${thresholds[key]}`);
      }
    });
  }

  /**
   * Detect alerts based on current metrics
   * @returns {Array} Detected alerts
   */
  detectAlerts() {
    const alerts = [];
    const metrics = this.currentMetrics;

    // Check for global alerts
    if (metrics.summary.errorRate > this.alertThresholds.errorRate) {
      alerts.push({
        type: "global",
        severity:
          metrics.summary.errorRate > this.alertThresholds.errorRate * 2
            ? "critical"
            : "warning",
        message: `High error rate: ${metrics.summary.errorRate.toFixed(2)}%`,
        threshold: this.alertThresholds.errorRate,
        value: metrics.summary.errorRate,
      });
    }

    if (
      metrics.summary.averageResponseTime > this.alertThresholds.responseTime
    ) {
      alerts.push({
        type: "global",
        severity:
          metrics.summary.averageResponseTime >
          this.alertThresholds.responseTime * 2
            ? "critical"
            : "warning",
        message: `High average response time: ${metrics.summary.averageResponseTime.toFixed(
          2
        )}ms`,
        threshold: this.alertThresholds.responseTime,
        value: metrics.summary.averageResponseTime,
      });
    }

    // Check backend-specific alerts
    for (const stat of metrics.haproxy.stats) {
      if (stat.type === "backend") {
        // Check queue size
        const queueSize = parseInt(stat.qcur || 0, 10);
        if (queueSize > this.alertThresholds.queueSize) {
          alerts.push({
            type: "backend",
            name: stat.name,
            severity:
              queueSize > this.alertThresholds.queueSize * 2
                ? "critical"
                : "warning",
            message: `High queue size for backend ${stat.name}: ${queueSize}`,
            threshold: this.alertThresholds.queueSize,
            value: queueSize,
          });
        }

        // Check error rates (4xx, 5xx)
        const errors4xx = parseInt(stat.hrsp_4xx || 0, 10);
        const errors5xx = parseInt(stat.hrsp_5xx || 0, 10);
        const totalRequests = parseInt(stat.req_tot || 0, 10);

        if (totalRequests > 0) {
          const errorRate = ((errors4xx + errors5xx) / totalRequests) * 100;

          if (errorRate > this.alertThresholds.errorRate) {
            alerts.push({
              type: "backend",
              name: stat.name,
              severity:
                errorRate > this.alertThresholds.errorRate * 2
                  ? "critical"
                  : "warning",
              message: `High error rate for backend ${
                stat.name
              }: ${errorRate.toFixed(2)}%`,
              threshold: this.alertThresholds.errorRate,
              value: errorRate,
            });
          }
        }
      }
    }

    return alerts;
  }

  /**
   * Force an immediate metrics collection
   * @returns {Promise<Object>} Collected metrics
   */
  async forceCollection() {
    logger.info("Forcing immediate metrics collection");
    return await this.collectMetrics();
  }

  /**
   * Get a metrics snapshot for a specific time range
   * @param {string} type - Type of snapshot ('general', 'backend', 'server')
   * @param {Object} options - Snapshot options
   * @returns {Object} Metrics snapshot
   */
  getMetricsSnapshot(type = "general", options = {}) {
    try {
      const now = new Date();

      switch (type) {
        case "general":
          return {
            timestamp: now.toISOString(),
            current: this.getCurrentMetrics().summary,
            history: this.getMetricsHistory(options.limit || 10),
            trafficPatterns: this.getTrafficPatterns(),
          };

        case "backend":
          if (!options.name) {
            return { error: "Backend name is required" };
          }
          return {
            timestamp: now.toISOString(),
            name: options.name,
            history: this.getBackendHistory(options.name, options.limit || 10),
          };

        case "server":
          if (!options.backend || !options.server) {
            return { error: "Backend and server names are required" };
          }
          return {
            timestamp: now.toISOString(),
            backend: options.backend,
            server: options.server,
            history: this.getServerHistory(
              options.backend,
              options.server,
              options.limit || 10
            ),
          };

        default:
          return { error: "Invalid snapshot type" };
      }
    } catch (err) {
      logger.error(`Failed to get metrics snapshot: ${err.message}`);
      return { error: err.message };
    }
  }

  /**
   * Shut down the metrics collector
   */
  shutdown() {
    this.stopCollection();

    // Save traffic patterns before shutdown
    if (this.persistMetrics) {
      this.saveTrafficPatterns().catch((err) => {
        logger.error(
          `Failed to save traffic patterns during shutdown: ${err.message}`
        );
      });
    }

    logger.info("HAProxy metrics collector shutdown");
  }
}

module.exports = HAProxyMetricsCollector;
