/**
 * Metrics Controller
 *
 * Provides HTTP API endpoints for accessing Traefik metrics and performance data
 * Part of the Phase 3 system observability enhancements
 */

const path = require("path");
const fs = require("fs").promises;
const { AppError } = require("../../utils/errorHandler");
const logger = require("../../utils/logger").getLogger("metricsController");
const traefikMetricsManager = require("../../utils/traefikMetricsManager");

/**
 * Get dashboard data with key metrics for front-end visualization
 */
exports.getDashboardData = async (req, res, next) => {
  try {
    // Initialize metrics manager if not already initialized
    if (!traefikMetricsManager.isInitialized()) {
      await traefikMetricsManager.initialize();
    }

    // Get current metrics and active alerts
    const currentMetrics = traefikMetricsManager.getCurrentMetrics();
    const activeAlerts = traefikMetricsManager.getActiveAlerts();

    // Get performance stats for the last hour
    const performanceStats = traefikMetricsManager.getPerformanceStats();

    // Get historical metrics for charts (last day)
    const historicalMetrics = traefikMetricsManager.getHistoricalMetrics("day");

    // Combine data for dashboard view
    const dashboardData = {
      summary: {
        totalConnections: currentMetrics.general?.connections?.current || 0,
        maxConnections: currentMetrics.general?.connections?.max || 0,
        connectionRate: currentMetrics.general?.connectionRate || 0,
        totalRequests: currentMetrics.general?.requests || 0,
        requestRate: currentMetrics.general?.requestRate || 0,
        activeBackends:
          currentMetrics.backends?.filter((b) => b.status === "UP")?.length ||
          0,
        totalBackends: currentMetrics.backends?.length || 0,
        alertsCount: activeAlerts?.length || 0,
      },
      charts: {
        connections: historicalMetrics.connections || [],
        requests: historicalMetrics.requests || [],
        responseTime: historicalMetrics.responseTime || [],
        errors: historicalMetrics.errors || [],
      },
      alerts: activeAlerts?.slice(0, 5) || [],
      performance: {
        avgResponseTime: performanceStats.avgResponseTime || 0,
        p95ResponseTime: performanceStats.p95ResponseTime || 0,
        errorRate: performanceStats.errorRate || 0,
        successRate: performanceStats.successRate || 0,
        trends: performanceStats.trends || {},
      },
      lastUpdated: new Date().toISOString(),
    };

    res.json(dashboardData);
  } catch (err) {
    logger.error(`Error getting dashboard data: ${err.message}`);
    next(
      new AppError(`Failed to get metrics dashboard data: ${err.message}`, 500)
    );
  }
};

/**
 * Get the current Traefik metrics snapshot
 */
exports.getCurrentMetrics = async (req, res, next) => {
  try {
    // Initialize metrics manager if not already initialized
    if (!traefikMetricsManager.isInitialized()) {
      await traefikMetricsManager.initialize();
    }

    const metrics = traefikMetricsManager.getCurrentMetrics();
    res.json(metrics);
  } catch (err) {
    logger.error(`Error getting current metrics: ${err.message}`);
    next(new AppError(`Failed to get current metrics: ${err.message}`, 500));
  }
};

/**
 * Get historical Traefik metrics for a specified timeframe
 */
exports.getHistoricalMetrics = async (req, res, next) => {
  try {
    const timeframe = req.query.timeframe || "hour"; // 'hour', 'day', 'week', 'custom'
    let startTime = null;
    let endTime = null;

    // Parse custom timeframe parameters if provided
    if (timeframe === "custom" && req.query.start && req.query.end) {
      try {
        startTime = new Date(req.query.start);
        endTime = new Date(req.query.end);
      } catch (e) {
        return next(
          new AppError("Invalid date format for custom timeframe", 400)
        );
      }
    }

    // Initialize metrics manager if not already initialized
    if (!traefikMetricsManager.isInitialized()) {
      await traefikMetricsManager.initialize();
    }

    const metrics = traefikMetricsManager.getHistoricalMetrics(
      timeframe,
      startTime,
      endTime
    );
    res.json(metrics);
  } catch (err) {
    logger.error(`Error getting historical metrics: ${err.message}`);
    next(new AppError(`Failed to get historical metrics: ${err.message}`, 500));
  }
};

/**
 * Get performance statistics and trends
 */
exports.getPerformanceStats = async (req, res, next) => {
  try {
    // Initialize metrics manager if not already initialized
    if (!traefikMetricsManager.isInitialized()) {
      await traefikMetricsManager.initialize();
    }

    const stats = traefikMetricsManager.getPerformanceStats();
    res.json(stats);
  } catch (err) {
    logger.error(`Error getting performance stats: ${err.message}`);
    next(
      new AppError(`Failed to get performance statistics: ${err.message}`, 500)
    );
  }
};

/**
 * Get active alerts
 */
exports.getActiveAlerts = async (req, res, next) => {
  try {
    // Initialize metrics manager if not already initialized
    if (!traefikMetricsManager.isInitialized()) {
      await traefikMetricsManager.initialize();
    }

    const alerts = traefikMetricsManager.getActiveAlerts();
    res.json(alerts);
  } catch (err) {
    logger.error(`Error getting active alerts: ${err.message}`);
    next(new AppError(`Failed to get active alerts: ${err.message}`, 500));
  }
};

/**
 * Get alert history
 */
exports.getAlertHistory = async (req, res, next) => {
  try {
    // Initialize metrics manager if not already initialized
    if (!traefikMetricsManager.isInitialized()) {
      await traefikMetricsManager.initialize();
    }

    const alertHistory = traefikMetricsManager.getAlertHistory();
    res.json(alertHistory);
  } catch (err) {
    logger.error(`Error getting alert history: ${err.message}`);
    next(new AppError(`Failed to get alert history: ${err.message}`, 500));
  }
};

/**
 * Export metrics to a file and provide a download link
 */
exports.exportMetrics = async (req, res, next) => {
  try {
    const format = req.query.format || "json"; // 'json', 'csv'
    const timeframe = req.query.timeframe || "day"; // 'hour', 'day', 'week', 'all'

    if (!["json", "csv"].includes(format)) {
      return next(
        new AppError('Invalid export format. Must be "json" or "csv"', 400)
      );
    }

    if (!["hour", "day", "week", "all"].includes(timeframe)) {
      return next(
        new AppError(
          'Invalid timeframe. Must be "hour", "day", "week", or "all"',
          400
        )
      );
    }

    // Initialize metrics manager if not already initialized
    if (!traefikMetricsManager.isInitialized()) {
      await traefikMetricsManager.initialize();
    }

    // Export metrics to a file
    const filePath = await traefikMetricsManager.exportMetrics(
      format,
      timeframe
    );

    // Set content type based on format
    const contentType = format === "json" ? "application/json" : "text/csv";

    // Generate download filename
    const filename = `traefik-metrics-${timeframe}-${
      new Date().toISOString().split("T")[0]
    }.${format}`;

    // Send the file as an attachment
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    // Stream the file to response
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);

    // Delete the file after sending (optional)
    fileStream.on("end", async () => {
      try {
        await fs.unlink(filePath);
      } catch (err) {
        logger.error(`Failed to delete temporary export file: ${err.message}`);
      }
    });
  } catch (err) {
    logger.error(`Error exporting metrics: ${err.message}`);
    next(new AppError(`Failed to export metrics: ${err.message}`, 500));
  }
};

/**
 * Update alert thresholds
 */
exports.updateAlertThresholds = async (req, res, next) => {
  try {
    const thresholds = req.body;

    if (!thresholds || typeof thresholds !== "object") {
      return next(new AppError("Invalid thresholds data", 400));
    }

    // Initialize metrics manager if not already initialized
    if (!traefikMetricsManager.isInitialized()) {
      await traefikMetricsManager.initialize();
    }

    // Update thresholds
    traefikMetricsManager.setThresholds(thresholds);

    // Return updated thresholds
    const updatedThresholds = traefikMetricsManager.getThresholds();
    res.json({
      message: "Alert thresholds updated successfully",
      thresholds: updatedThresholds,
    });
  } catch (err) {
    logger.error(`Error updating alert thresholds: ${err.message}`);
    next(
      new AppError(`Failed to update alert thresholds: ${err.message}`, 500)
    );
  }
};
