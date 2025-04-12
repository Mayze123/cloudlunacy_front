/**
 * HAProxy Route Handlers
 */
const express = require("express");
const router = express.Router();
const haproxyController = require("../controllers/haproxyController");

// HAProxy Configuration Routes
router.get("/routes", haproxyController.getAllRoutes);
router.get("/routes/:agentId", haproxyController.getAgentRoutes);
router.post("/routes/http", haproxyController.addHttpRoute);
router.post("/routes/mongodb", haproxyController.addMongodbRoute);
router.delete(
  "/routes/:type/:agentId/:subdomain?",
  haproxyController.removeRoute
);
router.put("/routes/bulk", haproxyController.updateMultipleRoutes);

// HAProxy Status & Management Routes
router.get("/health", haproxyController.getHealth);
router.post("/recover", haproxyController.recoverService);
router.get("/stats", haproxyController.getStats);
router.get("/validate", haproxyController.validateConfig);

// HAProxy Metrics Routes
router.get("/metrics", haproxyController.getMetrics);
router.get("/metrics/history", haproxyController.getMetricsHistory);
router.get("/metrics/anomalies", haproxyController.getMetricsAnomalies);

// HAProxy Load Optimizer Routes
router.get("/optimizer/status", haproxyController.getOptimizerStatus);
router.get("/optimizer/history", haproxyController.getOptimizationHistory);
router.post("/optimizer/optimize", haproxyController.triggerOptimization);
router.put("/optimizer/settings", haproxyController.updateOptimizerSettings);
router.get(
  "/optimizer/traffic-patterns/:backend",
  haproxyController.getTrafficPatterns
);

module.exports = router;
