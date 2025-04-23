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
 * Traefik Health
 * GET /api/health/traefik - Get detailed Traefik health metrics
 */
router.get("/traefik", healthController.getTraefikHealth);

/**
 * Traefik Statistics
 * GET /api/health/traefik/stats - Get Traefik statistics
 */
router.get(
  "/traefik/stats",
  authMiddleware.requireAuth,
  healthController.getTraefikStats
);

/**
 * Traefik Recovery
 * POST /api/health/traefik/recover - Attempt to recover Traefik service
 */
router.post(
  "/traefik/recover",
  authMiddleware.requireAuth,
  authMiddleware.requireAdmin,
  healthController.recoverTraefikService
);

/**
 * Traefik Configuration Validation
 * GET /api/health/traefik/validate - Validate Traefik configuration
 */
router.get(
  "/traefik/validate",
  authMiddleware.requireAuth,
  healthController.validateTraefikConfig
);

/**
 * HAProxy Health (Legacy - Kept for backward compatibility)
 * GET /api/health/haproxy - Redirects to Traefik health
 */
router.get("/haproxy", healthController.getTraefikHealth);

/**
 * HAProxy Statistics (Legacy - Kept for backward compatibility)
 * GET /api/health/haproxy/stats - Redirects to Traefik stats
 */
router.get(
  "/haproxy/stats",
  authMiddleware.requireAuth,
  healthController.getTraefikStats
);

/**
 * HAProxy Recovery (Legacy - Kept for backward compatibility)
 * POST /api/health/haproxy/recover - Redirects to Traefik recovery
 */
router.post(
  "/haproxy/recover",
  authMiddleware.requireAuth,
  authMiddleware.requireAdmin,
  healthController.recoverTraefikService
);

/**
 * HAProxy Configuration Validation (Legacy - Kept for backward compatibility)
 * GET /api/health/haproxy/validate - Redirects to Traefik validation
 */
router.get(
  "/haproxy/validate",
  authMiddleware.requireAuth,
  healthController.validateTraefikConfig
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

module.exports = router;
