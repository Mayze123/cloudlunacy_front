/**
 * Health Routes
 *
 * Routes for system health monitoring, proxy management, and certificate management.
 */

const express = require("express");
const router = express.Router();
const healthController = require("../controllers/healthController");
const authMiddleware = require("../middleware/auth");

/**
 * Basic Health Check
 * GET /api/health - Simple health check endpoint
 */
router.get("/", healthController.getBasicHealth);

/**
 * Health Dashboard
 * GET /api/health/dashboard - Get comprehensive health dashboard with all components
 */
router.get(
  "/dashboard",
  authMiddleware.requireAuth,
  healthController.getHealthDashboard
);

/**
 * System Health
 * GET /api/health/system - Get detailed health of all system components
 */
router.get("/system", healthController.getSystemHealth);

/**
 * Consul Health
 * GET /api/health/consul - Get detailed Consul health metrics
 */
router.get("/consul", healthController.checkConsul);

/**
 * Consul Recovery
 * POST /api/health/consul/recover - Attempt to recover Consul service
 */
router.post(
  "/consul/recover",
  authMiddleware.requireAuth,
  authMiddleware.requireAdmin,
  healthController.recoverConsulService
);

/**
 * Certificate Status Report
 * GET /api/health/certificates - Get certificate status report
 */
router.get(
  "/certificates",
  authMiddleware.requireAuth,
  healthController.getCertificateReport
);

/**
 * Certificate Metrics
 * GET /api/health/certificates/metrics - Get certificate metrics
 */
router.get("/certificates/metrics", healthController.getCertificateMetrics);

/**
 * Certificate Validation
 * POST /api/health/certificates/validate - Validate a certificate
 */
router.post(
  "/certificates/validate",
  authMiddleware.requireAuth,
  healthController.validateCertificate
);

/**
 * Certificate Renewal
 * POST /api/health/certificates/renew - Request certificate renewal
 */
router.post(
  "/certificates/renew",
  authMiddleware.requireAuth,
  authMiddleware.requireAdmin,
  healthController.renewCertificate
);

/**
 * Let's Encrypt Certificate Generation
 * POST /api/health/certificates/generate/letsencrypt - Generate Let's Encrypt certificate
 */
router.post(
  "/certificates/generate/letsencrypt",
  authMiddleware.requireAuth,
  authMiddleware.requireAdmin,
  healthController.generateLetsEncryptCertificate
);

/**
 * MongoDB Listener Check
 * GET /api/health/mongodb-listener - Check MongoDB listener status
 */
router.get(
  "/mongodb-listener",
  authMiddleware.requireAuth,
  healthController.checkMongoDBListener
);

/**
 * MongoDB Connections Check
 * GET /api/health/mongodb-connections - Check MongoDB connections
 */
router.get(
  "/mongodb-connections",
  authMiddleware.requireAuth,
  healthController.checkMongoDBConnections
);

module.exports = router;
