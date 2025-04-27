/**
 * Traefik Metrics Manager
 *
 * Collects, processes and stores metrics from Traefik for monitoring and observability.
 * Provides historical data tracking, alert detection, and performance analysis.
 */

const fs = require("fs").promises;
const path = require("path");
const axios = require("axios");
const logger = require("./logger").getLogger("traefikMetricsManager");
const pathManager = require("./pathManager");
const retryHandler = require("./retryHandler");

class TraefikMetricsManager {
  constructor() {
    this.initialized = false;
    this.metricsDir = null;
    this.currentMetrics = {
      general: {
        connections: { current: 0, max: 0 },
        connectionRate: 0,
        requests: 0,
        requestRate: 0,
        uptime: 0,
      },
      backends: [],
      frontends: [],
      services: [],
    };

    // Historical metrics storage
    this.historicalMetrics = {
      hour: [], // Last hour, 1-minute intervals
      day: [], // Last 24 hours, 5-minute intervals
      week: [], // Last 7 days, hourly intervals
    };

    // Active alerts
    this.activeAlerts = [];

    // Alert history
    this.alertHistory = [];

    // Alert thresholds
    this.thresholds = {
      connectionRate: 1000,
      requestRate: 5000,
      responseTime: 2000, // ms
      errorRate: 0.05, // 5%
      backendDownCount: 1,
    };

    // Metrics collection interval in ms
    this.collectionInterval = 60000; // 1 minute
    this.collectionTimer = null;

    // Traefik API configuration
    this.traefikApiUrl =
      process.env.TRAEFIK_API_URL || "http://localhost:8080/api";
    this.traefikMetricsUrl =
      process.env.TRAEFIK_METRICS_URL || `${this.traefikApiUrl}/metrics`;
  }

  /**
   * Initialize the metrics manager
   */
  async initialize() {
    try {
      logger.info("Initializing Traefik metrics manager");

      // Set up metrics directory
      if (!pathManager.initialized) {
        await pathManager.initialize();
      }

      // Create metrics directory if it doesn't exist
      this.metricsDir = path.join(pathManager.getPath("data"), "metrics");
      await fs.mkdir(this.metricsDir, { recursive: true });

      // Initialize historical metrics from stored data
      await this.loadHistoricalMetrics();

      // Start metrics collection
      this.startMetricsCollection();

      this.initialized = true;
      logger.info("Traefik metrics manager initialized successfully");
      return true;
    } catch (err) {
      logger.error(
        `Failed to initialize Traefik metrics manager: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
        }
      );
      return false;
    }
  }

  /**
   * Start collecting metrics at regular intervals
   */
  startMetricsCollection() {
    if (this.collectionTimer) {
      clearInterval(this.collectionTimer);
    }

    logger.info(
      `Starting metrics collection at ${this.collectionInterval}ms intervals`
    );

    // Collect metrics immediately
    this.collectMetrics().catch((err) => {
      logger.error(`Initial metrics collection failed: ${err.message}`);
    });

    // Set up regular collection
    this.collectionTimer = setInterval(() => {
      this.collectMetrics().catch((err) => {
        logger.error(`Scheduled metrics collection failed: ${err.message}`);
      });
    }, this.collectionInterval);
  }

  /**
   * Stop metrics collection
   */
  stopMetricsCollection() {
    if (this.collectionTimer) {
      clearInterval(this.collectionTimer);
      this.collectionTimer = null;
      logger.info("Metrics collection stopped");
    }
  }

  /**
   * Collect metrics from Traefik
   */
  async collectMetrics() {
    try {
      // Get metrics from Traefik API with retry handling
      const metrics = await retryHandler.withRetry(
        async () => {
          // Try to get metrics from the API
          try {
            const response = await axios.get(this.traefikMetricsUrl, {
              timeout: 5000,
            });
            return this.parseMetricsData(response.data);
          } catch (err) {
            logger.warn(
              `Failed to fetch metrics from Traefik API: ${err.message}`
            );
            throw err;
          }
        },
        {
          maxAttempts: 3,
          retryDelay: 1000,
          onRetry: (err, attempt) => {
            logger.warn(`Retry ${attempt} fetching metrics: ${err.message}`);
          },
        }
      );

      if (!metrics) {
        logger.warn("Failed to collect metrics after retries");
        return;
      }

      // Update current metrics
      this.currentMetrics = {
        ...metrics,
        timestamp: new Date().toISOString(),
      };

      // Update historical metrics
      this.updateHistoricalMetrics(this.currentMetrics);

      // Check for alerts
      this.detectAlerts(this.currentMetrics);

      // Save metrics to disk periodically
      await this.saveMetricsSnapshot();

      logger.debug("Metrics collected successfully");
      return this.currentMetrics;
    } catch (err) {
      logger.error(`Error collecting metrics: ${err.message}`);
      throw err;
    }
  }

  /**
   * Parse metrics data from Traefik
   * @param {string|object} data - Raw metrics data from Traefik
   * @returns {object} Structured metrics object
   */
  parseMetricsData(data) {
    // If data is already an object, return it as-is
    if (typeof data === "object" && data !== null) {
      return data;
    }

    // Parse raw metrics data (Prometheus format or JSON)
    try {
      // Try to parse as JSON first
      if (typeof data === "string" && data.trim().startsWith("{")) {
        return JSON.parse(data);
      }

      // Otherwise, parse as Prometheus format
      const metrics = {
        general: {
          connections: { current: 0, max: 0 },
          connectionRate: 0,
          requests: 0,
          requestRate: 0,
          uptime: 0,
        },
        backends: [],
        frontends: [],
        services: [],
      };

      // Simple prometheus format parser
      // This is a basic implementation - expand as needed for your metrics
      if (typeof data === "string") {
        const lines = data.split("\n");

        for (const line of lines) {
          // Skip comments and empty lines
          if (line.startsWith("#") || line.trim() === "") {
            continue;
          }

          // Parse metric line
          const match = line.match(/^([^{]+)({([^}]*)})?[ \t]*(.+)$/);
          if (match) {
            const [_, metricName, __, labels, valueStr] = match;
            const value = parseFloat(valueStr);

            // Process specific metrics
            if (metricName === "traefik_entrypoint_requests_total") {
              metrics.general.requests = value;
            } else if (metricName === "traefik_entrypoint_open_connections") {
              metrics.general.connections.current = value;
            } else if (
              metricName === "traefik_service_request_duration_seconds"
            ) {
              // Parse backend/service metrics from labels
              if (labels) {
                const serviceMatch = labels.match(/service="([^"]+)"/);
                if (serviceMatch) {
                  const serviceName = serviceMatch[1];

                  // Find or create service entry
                  let service = metrics.services.find(
                    (s) => s.name === serviceName
                  );
                  if (!service) {
                    service = {
                      name: serviceName,
                      responseTime: 0,
                      requests: 0,
                      status: "UP",
                    };
                    metrics.services.push(service);
                  }

                  // Update response time if this is the average
                  if (labels.includes('quantile="0.5"')) {
                    service.responseTime = value * 1000; // Convert to ms
                  }
                }
              }
            }
          }
        }
      }

      return metrics;
    } catch (err) {
      logger.error(`Failed to parse metrics data: ${err.message}`);
      return {
        general: {
          connections: { current: 0, max: 0 },
          connectionRate: 0,
          requests: 0,
          requestRate: 0,
          uptime: 0,
        },
        backends: [],
        frontends: [],
        services: [],
      };
    }
  }

  /**
   * Update historical metrics with new data
   * @param {object} metrics - Current metrics snapshot
   */
  updateHistoricalMetrics(metrics) {
    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      connections: metrics.general.connections.current,
      requests: metrics.general.requests,
      responseTime: this.calculateAverageResponseTime(metrics),
      errors: this.calculateErrorRate(metrics) * 100, // Convert to percentage
      services: metrics.services.map((service) => ({
        name: service.name,
        status: service.status,
        responseTime: service.responseTime || 0,
      })),
    };

    // Add to hourly metrics (keep last 60 entries = 1 hour at 1-minute intervals)
    this.historicalMetrics.hour.push(entry);
    if (this.historicalMetrics.hour.length > 60) {
      this.historicalMetrics.hour.shift();
    }

    // Add to daily metrics every 5 minutes (keep last 288 entries = 24 hours at 5-minute intervals)
    if (this.historicalMetrics.hour.length % 5 === 0) {
      this.historicalMetrics.day.push(entry);
      if (this.historicalMetrics.day.length > 288) {
        this.historicalMetrics.day.shift();
      }
    }

    // Add to weekly metrics every hour (keep last 168 entries = 7 days at 1-hour intervals)
    if (this.historicalMetrics.hour.length % 60 === 0) {
      this.historicalMetrics.week.push(entry);
      if (this.historicalMetrics.week.length > 168) {
        this.historicalMetrics.week.shift();
      }
    }
  }

  /**
   * Calculate average response time across all services
   * @param {object} metrics - Current metrics snapshot
   * @returns {number} Average response time in ms
   */
  calculateAverageResponseTime(metrics) {
    if (!metrics.services || metrics.services.length === 0) {
      return 0;
    }

    const servicesWithTime = metrics.services.filter(
      (service) =>
        typeof service.responseTime === "number" && service.responseTime > 0
    );

    if (servicesWithTime.length === 0) {
      return 0;
    }

    const total = servicesWithTime.reduce(
      (sum, service) => sum + service.responseTime,
      0
    );
    return total / servicesWithTime.length;
  }

  /**
   * Calculate error rate
   * @param {object} metrics - Current metrics snapshot
   * @returns {number} Error rate as a fraction (0-1)
   */
  calculateErrorRate(metrics) {
    if (!metrics.services || metrics.services.length === 0) {
      return 0;
    }

    const totalServices = metrics.services.length;
    const downServices = metrics.services.filter(
      (service) => service.status === "DOWN"
    ).length;

    return totalServices > 0 ? downServices / totalServices : 0;
  }

  /**
   * Detect alerts based on current metrics
   * @param {object} metrics - Current metrics snapshot
   */
  detectAlerts(metrics) {
    const alerts = [];
    const timestamp = new Date().toISOString();

    // Check connection rate
    if (metrics.general.connectionRate > this.thresholds.connectionRate) {
      alerts.push({
        id: `conn-rate-${Date.now()}`,
        type: "connection_rate",
        severity: "warning",
        message: `High connection rate: ${metrics.general.connectionRate} connections/sec`,
        timestamp,
        value: metrics.general.connectionRate,
        threshold: this.thresholds.connectionRate,
      });
    }

    // Check request rate
    if (metrics.general.requestRate > this.thresholds.requestRate) {
      alerts.push({
        id: `req-rate-${Date.now()}`,
        type: "request_rate",
        severity: "warning",
        message: `High request rate: ${metrics.general.requestRate} requests/sec`,
        timestamp,
        value: metrics.general.requestRate,
        threshold: this.thresholds.requestRate,
      });
    }

    // Check response time
    const avgResponseTime = this.calculateAverageResponseTime(metrics);
    if (avgResponseTime > this.thresholds.responseTime) {
      alerts.push({
        id: `resp-time-${Date.now()}`,
        type: "response_time",
        severity: "warning",
        message: `High average response time: ${avgResponseTime.toFixed(2)}ms`,
        timestamp,
        value: avgResponseTime,
        threshold: this.thresholds.responseTime,
      });
    }

    // Check error rate
    const errorRate = this.calculateErrorRate(metrics);
    if (errorRate > this.thresholds.errorRate) {
      alerts.push({
        id: `error-rate-${Date.now()}`,
        type: "error_rate",
        severity: "critical",
        message: `High error rate: ${(errorRate * 100).toFixed(2)}%`,
        timestamp,
        value: errorRate,
        threshold: this.thresholds.errorRate,
      });
    }

    // Check backend/service status
    const downServices = metrics.services.filter(
      (service) => service.status === "DOWN"
    );
    if (downServices.length >= this.thresholds.backendDownCount) {
      alerts.push({
        id: `services-down-${Date.now()}`,
        type: "services_down",
        severity: "critical",
        message: `${downServices.length} services are down`,
        timestamp,
        value: downServices.length,
        threshold: this.thresholds.backendDownCount,
        details: downServices.map((service) => service.name),
      });
    }

    // Update active alerts
    if (alerts.length > 0) {
      for (const alert of alerts) {
        this.activeAlerts.push(alert);
        this.alertHistory.push(alert);
      }

      // Limit active alerts array size
      if (this.activeAlerts.length > 100) {
        this.activeAlerts = this.activeAlerts.slice(-100);
      }

      // Limit alert history array size
      if (this.alertHistory.length > 1000) {
        this.alertHistory = this.alertHistory.slice(-1000);
      }

      logger.warn(`${alerts.length} new alerts detected`);
    }
  }

  /**
   * Mark an alert as resolved
   * @param {string} alertId - ID of the alert to resolve
   */
  resolveAlert(alertId) {
    const alertIndex = this.activeAlerts.findIndex((a) => a.id === alertId);
    if (alertIndex !== -1) {
      const alert = this.activeAlerts[alertIndex];
      alert.resolved = true;
      alert.resolvedAt = new Date().toISOString();

      // Update in history
      const historyAlert = this.alertHistory.find((a) => a.id === alertId);
      if (historyAlert) {
        historyAlert.resolved = true;
        historyAlert.resolvedAt = alert.resolvedAt;
      }

      // Remove from active alerts
      this.activeAlerts.splice(alertIndex, 1);

      logger.info(`Alert ${alertId} resolved`);
      return true;
    }
    return false;
  }

  /**
   * Save current metrics to disk
   */
  async saveMetricsSnapshot() {
    try {
      // Create a metrics snapshot file
      const timestamp = new Date().toISOString().replace(/:/g, "-");
      const snapshotFile = path.join(
        this.metricsDir,
        `metrics-${timestamp}.json`
      );

      // Prepare data to save
      const data = JSON.stringify(
        {
          current: this.currentMetrics,
          activeAlerts: this.activeAlerts,
        },
        null,
        2
      );

      // Write to file
      await fs.writeFile(snapshotFile, data, "utf8");

      // Clean up old snapshots (keep last 100)
      await this.cleanupOldSnapshots();

      // Every hour, save historical metrics
      const now = new Date();
      if (now.getMinutes() === 0) {
        await this.saveHistoricalMetrics();
      }

      return snapshotFile;
    } catch (err) {
      logger.error(`Failed to save metrics snapshot: ${err.message}`);
      return null;
    }
  }

  /**
   * Save historical metrics to disk
   */
  async saveHistoricalMetrics() {
    try {
      const historyFile = path.join(this.metricsDir, "historical-metrics.json");
      const data = JSON.stringify(this.historicalMetrics, null, 2);
      await fs.writeFile(historyFile, data, "utf8");

      const alertHistoryFile = path.join(this.metricsDir, "alert-history.json");
      const alertData = JSON.stringify(this.alertHistory, null, 2);
      await fs.writeFile(alertHistoryFile, alertData, "utf8");

      logger.info("Historical metrics saved to disk");
      return true;
    } catch (err) {
      logger.error(`Failed to save historical metrics: ${err.message}`);
      return false;
    }
  }

  /**
   * Load historical metrics from disk
   */
  async loadHistoricalMetrics() {
    try {
      // Load historical metrics
      const historyFile = path.join(this.metricsDir, "historical-metrics.json");
      try {
        const data = await fs.readFile(historyFile, "utf8");
        this.historicalMetrics = JSON.parse(data);
        logger.info("Historical metrics loaded from disk");
      } catch (err) {
        // If file doesn't exist or can't be parsed, use defaults
        logger.warn(
          `No historical metrics found, using defaults: ${err.message}`
        );
      }

      // Load alert history
      const alertHistoryFile = path.join(this.metricsDir, "alert-history.json");
      try {
        const alertData = await fs.readFile(alertHistoryFile, "utf8");
        this.alertHistory = JSON.parse(alertData);
        logger.info("Alert history loaded from disk");
      } catch (err) {
        logger.warn(`No alert history found, using defaults: ${err.message}`);
      }

      return true;
    } catch (err) {
      logger.error(`Failed to load historical metrics: ${err.message}`);
      return false;
    }
  }

  /**
   * Clean up old metrics snapshots
   */
  async cleanupOldSnapshots() {
    try {
      const files = await fs.readdir(this.metricsDir);
      const snapshots = files.filter(
        (f) => f.startsWith("metrics-") && f.endsWith(".json")
      );

      // Sort by timestamp (newest first)
      snapshots.sort().reverse();

      // Keep only the latest 100 snapshots
      if (snapshots.length > 100) {
        for (let i = 100; i < snapshots.length; i++) {
          await fs.unlink(path.join(this.metricsDir, snapshots[i]));
        }
        logger.debug(
          `Cleaned up ${snapshots.length - 100} old metrics snapshots`
        );
      }

      return true;
    } catch (err) {
      logger.error(`Failed to clean up old snapshots: ${err.message}`);
      return false;
    }
  }

  /**
   * Export metrics to a file
   * @param {string} format - Export format ('json' or 'csv')
   * @param {string} timeframe - Timeframe to export ('hour', 'day', 'week', 'all')
   * @returns {string} Path to the exported file
   */
  async exportMetrics(format = "json", timeframe = "day") {
    try {
      // Determine which data to export
      let dataToExport;

      if (timeframe === "hour") {
        dataToExport = this.historicalMetrics.hour;
      } else if (timeframe === "day") {
        dataToExport = this.historicalMetrics.day;
      } else if (timeframe === "week") {
        dataToExport = this.historicalMetrics.week;
      } else if (timeframe === "all") {
        // Combine all historical metrics
        dataToExport = [
          ...this.historicalMetrics.hour,
          ...this.historicalMetrics.day,
          ...this.historicalMetrics.week,
        ];
        // Remove duplicates based on timestamp
        const uniqueTimestamps = new Set();
        dataToExport = dataToExport.filter((entry) => {
          if (uniqueTimestamps.has(entry.timestamp)) {
            return false;
          }
          uniqueTimestamps.add(entry.timestamp);
          return true;
        });
        // Sort by timestamp
        dataToExport.sort(
          (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
        );
      }

      // Create export file
      const timestamp = new Date().toISOString().replace(/:/g, "-");
      const exportDir = path.join(this.metricsDir, "exports");
      await fs.mkdir(exportDir, { recursive: true });

      let exportFilePath;

      if (format === "json") {
        // Export as JSON
        exportFilePath = path.join(
          exportDir,
          `metrics-${timeframe}-${timestamp}.json`
        );
        await fs.writeFile(
          exportFilePath,
          JSON.stringify(dataToExport, null, 2),
          "utf8"
        );
      } else if (format === "csv") {
        // Export as CSV
        exportFilePath = path.join(
          exportDir,
          `metrics-${timeframe}-${timestamp}.csv`
        );

        // Create CSV header
        const headers = [
          "timestamp",
          "connections",
          "requests",
          "responseTime",
          "errors",
        ];

        // Create CSV content
        let csvContent = headers.join(",") + "\n";

        // Add data rows
        for (const entry of dataToExport) {
          const row = [
            entry.timestamp,
            entry.connections,
            entry.requests,
            entry.responseTime,
            entry.errors,
          ];
          csvContent += row.join(",") + "\n";
        }

        await fs.writeFile(exportFilePath, csvContent, "utf8");
      }

      logger.info(`Metrics exported to ${exportFilePath}`);
      return exportFilePath;
    } catch (err) {
      logger.error(`Failed to export metrics: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get the current metrics snapshot
   * @returns {object} Current metrics
   */
  getCurrentMetrics() {
    return {
      ...this.currentMetrics,
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Get historical metrics for a given timeframe
   * @param {string} timeframe - Timeframe ('hour', 'day', 'week', 'custom')
   * @param {Date} startTime - Start time for custom timeframe
   * @param {Date} endTime - End time for custom timeframe
   * @returns {object} Historical metrics data
   */
  getHistoricalMetrics(timeframe = "hour", startTime = null, endTime = null) {
    // Return data based on timeframe
    if (timeframe === "custom" && startTime && endTime) {
      // For custom timeframe, filter data within the specified range
      const filteredData = this.historicalMetrics.hour
        .concat(this.historicalMetrics.day, this.historicalMetrics.week)
        .filter((entry) => {
          const entryTime = new Date(entry.timestamp);
          return entryTime >= startTime && entryTime <= endTime;
        });

      // Remove duplicates based on timestamp
      const uniqueEntries = [];
      const timestamps = new Set();

      for (const entry of filteredData) {
        if (!timestamps.has(entry.timestamp)) {
          timestamps.add(entry.timestamp);
          uniqueEntries.push(entry);
        }
      }

      // Sort by timestamp
      uniqueEntries.sort(
        (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
      );

      return {
        timeframe: "custom",
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        connections: uniqueEntries.map((e) => ({
          timestamp: e.timestamp,
          value: e.connections,
        })),
        requests: uniqueEntries.map((e) => ({
          timestamp: e.timestamp,
          value: e.requests,
        })),
        responseTime: uniqueEntries.map((e) => ({
          timestamp: e.timestamp,
          value: e.responseTime,
        })),
        errors: uniqueEntries.map((e) => ({
          timestamp: e.timestamp,
          value: e.errors,
        })),
      };
    }

    // For standard timeframes
    const source = this.historicalMetrics[timeframe] || [];

    return {
      timeframe,
      connections: source.map((e) => ({
        timestamp: e.timestamp,
        value: e.connections,
      })),
      requests: source.map((e) => ({
        timestamp: e.timestamp,
        value: e.requests,
      })),
      responseTime: source.map((e) => ({
        timestamp: e.timestamp,
        value: e.responseTime,
      })),
      errors: source.map((e) => ({ timestamp: e.timestamp, value: e.errors })),
    };
  }

  /**
   * Get active alerts
   * @returns {Array} List of active alerts
   */
  getActiveAlerts() {
    return [...this.activeAlerts];
  }

  /**
   * Get alert history
   * @param {number} limit - Maximum number of alerts to return
   * @returns {Array} List of historical alerts
   */
  getAlertHistory(limit = 100) {
    // Return most recent alerts first
    return [...this.alertHistory]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);
  }

  /**
   * Get performance statistics
   * @returns {object} Performance statistics
   */
  getPerformanceStats() {
    // Calculate performance metrics from historical data
    const hourData = this.historicalMetrics.hour;

    if (!hourData || hourData.length === 0) {
      return {
        avgResponseTime: 0,
        p95ResponseTime: 0,
        errorRate: 0,
        successRate: 100,
        requestRate: 0,
        trends: {
          responseTime: "stable",
          errorRate: "stable",
          requests: "stable",
        },
      };
    }

    // Calculate average response time
    const responseTimeValues = hourData
      .map((entry) => entry.responseTime)
      .filter((time) => typeof time === "number" && !isNaN(time));

    const avgResponseTime =
      responseTimeValues.length > 0
        ? responseTimeValues.reduce((sum, time) => sum + time, 0) /
          responseTimeValues.length
        : 0;

    // Calculate 95th percentile response time
    const p95ResponseTime = this.calculatePercentile(responseTimeValues, 95);

    // Calculate error rate
    const errorRate =
      hourData.length > 0
        ? hourData.reduce((sum, entry) => sum + entry.errors, 0) /
          hourData.length /
          100 // Convert from percentage
        : 0;

    // Calculate success rate
    const successRate = 100 - errorRate * 100;

    // Calculate request rate
    const requestRate =
      hourData.length > 1
        ? (hourData[hourData.length - 1].requests - hourData[0].requests) /
          ((new Date(hourData[hourData.length - 1].timestamp) -
            new Date(hourData[0].timestamp)) /
            1000)
        : 0;

    // Calculate trends
    const trends = this.calculateTrends(hourData);

    return {
      avgResponseTime,
      p95ResponseTime,
      errorRate,
      successRate,
      requestRate,
      trends,
    };
  }

  /**
   * Calculate percentile value
   * @param {Array} values - Array of numeric values
   * @param {number} percentile - Percentile to calculate (0-100)
   * @returns {number} Percentile value
   */
  calculatePercentile(values, percentile) {
    if (!values || values.length === 0) {
      return 0;
    }

    // Sort values
    const sorted = [...values].sort((a, b) => a - b);

    // Calculate index
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;

    return sorted[Math.max(0, index)];
  }

  /**
   * Calculate trends from historical data
   * @param {Array} data - Historical metrics data
   * @returns {object} Trend indicators
   */
  calculateTrends(data) {
    if (!data || data.length < 2) {
      return {
        responseTime: "stable",
        errorRate: "stable",
        requests: "stable",
      };
    }

    // Split data into two halves
    const midpoint = Math.floor(data.length / 2);
    const firstHalf = data.slice(0, midpoint);
    const secondHalf = data.slice(midpoint);

    // Calculate averages for each half
    const avgResponseTime1 =
      firstHalf.reduce((sum, e) => sum + e.responseTime, 0) / firstHalf.length;
    const avgResponseTime2 =
      secondHalf.reduce((sum, e) => sum + e.responseTime, 0) /
      secondHalf.length;

    const avgErrorRate1 =
      firstHalf.reduce((sum, e) => sum + e.errors, 0) / firstHalf.length;
    const avgErrorRate2 =
      secondHalf.reduce((sum, e) => sum + e.errors, 0) / secondHalf.length;

    const avgRequests1 =
      firstHalf.reduce((sum, e) => sum + e.requests, 0) / firstHalf.length;
    const avgRequests2 =
      secondHalf.reduce((sum, e) => sum + e.requests, 0) / secondHalf.length;

    // Determine trends
    const responseTimeTrend = this.determineTrend(
      avgResponseTime1,
      avgResponseTime2,
      0.1
    );
    const errorRateTrend = this.determineTrend(
      avgErrorRate1,
      avgErrorRate2,
      0.2
    );
    const requestsTrend = this.determineTrend(avgRequests1, avgRequests2, 0.1);

    return {
      responseTime: responseTimeTrend,
      errorRate: errorRateTrend,
      requests: requestsTrend,
    };
  }

  /**
   * Determine trend direction based on change
   * @param {number} oldValue - Previous value
   * @param {number} newValue - Current value
   * @param {number} threshold - Significant change threshold (0-1)
   * @returns {string} Trend direction ('increasing', 'decreasing', 'stable')
   */
  determineTrend(oldValue, newValue, threshold = 0.1) {
    // Handle division by zero
    if (oldValue === 0) {
      return newValue > 0 ? "increasing" : "stable";
    }

    const change = (newValue - oldValue) / oldValue;

    if (change > threshold) {
      return "increasing";
    } else if (change < -threshold) {
      return "decreasing";
    } else {
      return "stable";
    }
  }

  /**
   * Update alert thresholds
   * @param {object} thresholds - New threshold values
   */
  setThresholds(thresholds) {
    // Validate and update thresholds
    if (typeof thresholds.connectionRate === "number") {
      this.thresholds.connectionRate = thresholds.connectionRate;
    }

    if (typeof thresholds.requestRate === "number") {
      this.thresholds.requestRate = thresholds.requestRate;
    }

    if (typeof thresholds.responseTime === "number") {
      this.thresholds.responseTime = thresholds.responseTime;
    }

    if (typeof thresholds.errorRate === "number") {
      this.thresholds.errorRate = thresholds.errorRate;
    }

    if (typeof thresholds.backendDownCount === "number") {
      this.thresholds.backendDownCount = thresholds.backendDownCount;
    }

    logger.info("Alert thresholds updated");
  }

  /**
   * Get current threshold settings
   * @returns {object} Current threshold values
   */
  getThresholds() {
    return { ...this.thresholds };
  }

  /**
   * Check if metrics manager is initialized
   * @returns {boolean} Initialization status
   */
  isInitialized() {
    return this.initialized;
  }

  /**
   * Clean up resources when shutting down
   */
  async shutdown() {
    // Stop metrics collection
    this.stopMetricsCollection();

    // Save current state
    try {
      await this.saveMetricsSnapshot();
      await this.saveHistoricalMetrics();
      logger.info("Metrics manager shut down successfully");
    } catch (err) {
      logger.error(`Error during metrics manager shutdown: ${err.message}`);
    }
  }
}

// Create and export singleton instance
const traefikMetricsManager = new TraefikMetricsManager();
module.exports = traefikMetricsManager;
