/**
 * Certificate Routes
 *
 * Handles all certificate-related API endpoints including:
 * - Agent certificate generation and management
 * - Certificate validation
 * - Let's Encrypt certificate management
 * - Certificate metrics and monitoring
 */

const express = require("express");
const router = express.Router();
const { asyncHandler } = require("../../utils/errorHandler");
const certificateController = require("../controllers/certificateController");
const auth = require("../middleware/auth");

/**
 * Get MongoDB CA certificate
 *
 * GET /api/certificates/ca
 * Public endpoint, no authentication required
 */
router.get("/mongodb-ca", certificateController.getMongoCA);

/**
 * Get certificate dashboard
 * Shows status of all certificates in the system
 *
 * GET /api/certificates/dashboard
 * Requires admin role
 */
router.get(
  "/dashboard",
  auth(["admin"]),
  asyncHandler(certificateController.getDashboardData)
);

/**
 * Get certificate metrics
 * Shows current metrics and trends
 *
 * GET /api/certificates/metrics
 * Requires admin role
 */
router.get(
  "/metrics",
  auth(["admin"]),
  asyncHandler(certificateController.getCertificateMetrics)
);

/**
 * Get historical certificate metrics
 * Shows metrics history for a specific time range
 *
 * GET /api/certificates/metrics/history
 * Requires admin role
 */
router.get(
  "/metrics/history",
  auth(["admin"]),
  asyncHandler(certificateController.getMetricsHistory)
);

/**
 * List all certificates in the system
 *
 * GET /api/certificates
 * Requires admin role
 */
router.get(
  "/",
  auth(["admin"]),
  asyncHandler(certificateController.getAllCertificates)
);

/**
 * Trigger certificate renewal check
 *
 * POST /api/certificates/renew-check
 * Requires admin role
 */
router.post(
  "/renew-check",
  auth(["admin"]),
  asyncHandler(certificateController.runRenewalCheck)
);

/**
 * Get agent certificates
 *
 * GET /api/certificates/agent/:agentId
 * Requires authentication and agent access
 */
router.get(
  "/agent/:agentId",
  auth(["admin", "agent"]),
  asyncHandler(certificateController.getAgentCertificates)
);

/**
 * Regenerate agent certificate
 *
 * POST /api/certificates/agent/:agentId/regenerate
 * Requires authentication and agent access
 */
router.post(
  "/agent/:agentId/regenerate",
  auth(["admin", "agent"]),
  asyncHandler(certificateController.regenerateAgentCertificate)
);

/**
 * Validate agent certificate setup
 *
 * GET /api/certificates/agent/:agentId/validate
 * Requires authentication and agent access
 */
router.get(
  "/agent/:agentId/validate",
  auth(["admin", "agent"]),
  asyncHandler(certificateController.validateAgentCertificate)
);

/**
 * Issue or renew Let's Encrypt wildcard certificate
 *
 * POST /api/certificates/letsencrypt
 * Requires admin role
 */
router.post(
  "/letsencrypt",
  auth(["admin"]),
  asyncHandler(certificateController.issueLetsEncryptCert)
);

/**
 * Get certificate provider types
 *
 * GET /api/certificates/providers
 * Requires admin role
 */
router.get(
  "/providers",
  auth(["admin"]),
  asyncHandler(certificateController.getCertificateProviderTypes)
);

/**
 * Get certificate provider configuration
 *
 * GET /api/certificates/providers/:providerType/config
 * Requires admin role
 */
router.get(
  "/providers/:providerType/config",
  auth(["admin"]),
  asyncHandler(certificateController.getCertificateProviderConfig)
);

/**
 * Get certificate provider capabilities
 *
 * GET /api/certificates/provider/capabilities
 * Requires admin role
 */
router.get(
  "/provider/capabilities",
  auth(["admin"]),
  asyncHandler(certificateController.getCertificateProviderCapabilities)
);

/**
 * Validate certificate provider configuration
 *
 * GET /api/certificates/provider/validate
 * Requires admin role
 */
router.get(
  "/provider/validate",
  auth(["admin"]),
  asyncHandler(certificateController.validateCertificateProviderConfig)
);

module.exports = router;
