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
const { requireRole } = require("../middleware/auth");

/**
 * Get MongoDB CA certificate
 *
 * GET /api/certificates/ca
 * Public endpoint, no authentication required
 */
router.get("/mongodb-ca", certificateController.getMongoCA);

/**
 * List all certificates in the system (public version)
 * Returns limited information without sensitive data
 *
 * GET /api/certificates/public
 * Public endpoint, no authentication required
 */
router.get(
  "/public",
  asyncHandler(certificateController.getPublicCertificateList)
);

/**
 * TEMPORARY: Force renewal of all certificates without auth
 * Remove this endpoint after testing is complete!
 *
 * GET /api/certificates/temp-renew-all
 * No authentication required - FOR DEVELOPMENT USE ONLY
 */
router.get(
  "/temp-renew-all",
  asyncHandler(async (req, res) => {
    try {
      const coreServices = require("../../services/core");

      if (!coreServices.certificateService) {
        return res.status(500).json({
          success: false,
          message: "Certificate service not available",
        });
      }

      if (!coreServices.certificateService.initialized) {
        await coreServices.certificateService.initialize();
      }

      const result =
        await coreServices.certificateService.checkAndRenewCertificates({
          forceRenewal: true,
          renewBeforeDays: 30,
        });

      return res.status(200).json({
        success: true,
        message: "All certificates have been renewed",
        result,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: "Certificate renewal failed",
        error: error.message,
      });
    }
  })
);

/**
 * Get certificate status
 *
 * GET /api/certificates/status
 * Requires admin role
 */
router.get("/status", requireRole("admin"), function (req, res) {
  // Explicitly define a handler function
  if (typeof certificateController.getCertificateStatus === "function") {
    return certificateController.getCertificateStatus(req, res);
  } else {
    return res.status(501).json({
      success: false,
      message: "Certificate status functionality not implemented yet",
    });
  }
});

/**
 * Get certificate metrics
 * Shows current metrics and trends
 *
 * GET /api/certificates/metrics
 * Requires admin role
 */
router.get("/metrics", requireRole("admin"), function (req, res) {
  // Explicitly define a handler function
  if (typeof certificateController.getCertificateMetrics === "function") {
    return certificateController.getCertificateMetrics(req, res);
  } else {
    return res.status(501).json({
      success: false,
      message: "Certificate metrics functionality not implemented yet",
    });
  }
});

/**
 * Get historical certificate metrics
 * Shows metrics history for a specific time range
 *
 * GET /api/certificates/metrics/history
 * Requires admin role
 */
router.get(
  "/metrics/history",
  requireRole("admin"),
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
  requireRole("admin"),
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
  requireRole("admin"),
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
  requireRole("admin"),
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
  requireRole("admin"),
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
  requireRole("admin"),
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
  requireRole("admin"),
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
  requireRole("admin"),
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
  requireRole("admin"),
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
  requireRole("admin"),
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
  requireRole("admin"),
  asyncHandler(certificateController.validateCertificateProviderConfig)
);

module.exports = router;
