/**
 * Metrics Routes
 *
 * Defines API routes for the metrics subsystem
 * Part of Phase 3 system observability enhancements
 */

const express = require("express");
const router = express.Router();
const metricsController = require("../controllers/metricsController");
const authMiddleware = require("../middleware/auth");

// Apply auth middleware to all metrics routes
router.use(authMiddleware.requireAuth);

// Dashboard data - comprehensive metrics for the front-end dashboard
router.get("/dashboard", metricsController.getDashboardData);

// Current metrics - get the current HAProxy metrics snapshot
router.get("/current", metricsController.getCurrentMetrics);

// Historical metrics - get historical data with optional timeframe parameter
router.get("/historical", metricsController.getHistoricalMetrics);

// Performance stats - get performance statistics and trends
router.get("/performance", metricsController.getPerformanceStats);

// Alerts - get active alerts
router.get("/alerts", metricsController.getActiveAlerts);

// Alert history - get historical alert data
router.get("/alerts/history", metricsController.getAlertHistory);

// Export metrics - download metrics data in JSON or CSV format
router.get("/export", metricsController.exportMetrics);

// Update alert thresholds - configure when alerts are triggered
router.post(
  "/alerts/thresholds",
  authMiddleware.requireAdmin(),
  metricsController.updateAlertThresholds
);

module.exports = router;
