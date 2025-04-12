/**
 * Certificate Controller
 */
const fs = require("fs").promises;
const logger = require("../../utils/logger").getLogger("certificateController");
const coreServices = require("../../services/core");
const { asyncHandler, AppError } = require("../../utils/errorHandler");
const pathManager = require("../../utils/pathManager");
const { execSync } = require("child_process");
const CertificateService = require("../../services/core/certificateService");
const CertificateMetricsService = require("../../services/core/certificateMetricsService");
const CertificateProviderFactory = require("../../utils/certProviders/providerFactory");

const certificateService = new CertificateService();
const certificateMetricsService = new CertificateMetricsService();

// Path to MongoDB CA certificate
const MONGO_CA_PATH =
  process.env.MONGO_CA_PATH ||
  pathManager.resolvePath("certs", "mongodb-ca.crt");

/**
 * Get MongoDB CA certificate
 */
exports.getMongoCA = async (req, res) => {
  try {
    // Check if certificate service is available
    if (
      coreServices.certificateService &&
      coreServices.certificateService.initialized
    ) {
      const caResult = await coreServices.certificateService.getCA();

      if (caResult.success) {
        res.set("Content-Type", "application/x-pem-file");
        res.set("Content-Disposition", 'attachment; filename="mongodb-ca.crt"');
        res.send(caResult.caCert);
        return;
      }
    }

    // Fall back to reading the file directly if service isn't available
    let caCert;

    try {
      // Try to read the certificate file
      caCert = await fs.readFile(MONGO_CA_PATH, "utf8");
    } catch (error) {
      logger.warn(
        `Failed to read MongoDB CA certificate from ${MONGO_CA_PATH}: ${error.message}`
      );

      // Instead of returning a placeholder, return a proper error
      return res.status(404).json({
        success: false,
        message: "MongoDB CA certificate not found",
        error: `Certificate file not found at ${MONGO_CA_PATH}`,
      });
    }

    res.set("Content-Type", "application/x-pem-file");
    res.set("Content-Disposition", 'attachment; filename="mongodb-ca.crt"');
    res.send(caCert);
  } catch (err) {
    logger.error(`Error getting MongoDB CA certificate: ${err.message}`);
    res.status(500).json({
      success: false,
      message: "Failed to get MongoDB CA certificate",
      error: err.message,
    });
  }
};

/**
 * Get agent certificates
 *
 * GET /api/certificates/agent/:agentId
 */
exports.getAgentCertificates = asyncHandler(async (req, res) => {
  const { agentId } = req.params;
  const { targetIp } = req.query;

  logger.info(
    `Generating certificates for agent ${agentId}${
      targetIp ? ` with IP ${targetIp}` : ""
    }`
  );

  // Check if user is authorized to access these certificates
  if (
    req.user &&
    (req.user.role === "admin" ||
      (req.user.role === "agent" && req.user.agentId === agentId))
  ) {
    // Initialize certificate service if needed
    if (!coreServices.certificateService) {
      throw new AppError("Certificate service not available", 500);
    }

    if (!coreServices.certificateService.initialized) {
      logger.info("Initializing certificate service");
      await coreServices.certificateService.initialize();
    }

    logger.info(`Generating certificate for agent ${agentId}`);

    try {
      // Get the certificates from the service
      await coreServices.certificateService.generateAgentCertificate(
        agentId,
        targetIp
      );

      // After generation, retrieve the actual certificate files
      const certFiles =
        await coreServices.certificateService.getAgentCertificates(agentId);

      logger.info(
        "Certificate generation result: " +
          JSON.stringify({ success: true, error: null })
      );

      // Return the certificate data
      return res.status(200).json({
        success: true,
        agentId,
        certificates: {
          serverKey: certFiles.serverKey,
          serverCert: certFiles.serverCert,
          caCert: certFiles.caCert,
        },
      });
    } catch (error) {
      logger.error(`Certificate generation error: ${error.message}`);
      throw new AppError(
        `Failed to generate agent certificates: ${error.message}`,
        500
      );
    }
  } else {
    throw new AppError("Unauthorized to access these certificates", 403);
  }
});

/**
 * Issue or renew Let's Encrypt wildcard certificate
 *
 * POST /api/certificates/letsencrypt
 * Requires admin role
 */
exports.issueLetsEncryptCert = asyncHandler(async (req, res) => {
  // Check if user is authorized (admin only)
  if (!req.user || req.user.role !== "admin") {
    throw new AppError("Unauthorized - Admin access required", 403);
  }

  // Check if Let's Encrypt service is available
  if (!coreServices.letsencryptService) {
    throw new AppError("Let's Encrypt service not available", 500);
  }

  if (!coreServices.letsencryptService.initialized) {
    logger.info("Initializing Let's Encrypt service");
    await coreServices.letsencryptService.initialize();
  }

  logger.info("Issuing/renewing Let's Encrypt certificate");

  // Check if we need to force renewal
  const forceRenewal = req.query.force === "true";

  let result;
  if (forceRenewal) {
    // Force issuance of new certificate
    result = await coreServices.letsencryptService.issueCertificates();
  } else {
    // Only renew if needed
    result = await coreServices.letsencryptService.renewIfNeeded();
  }

  return res.status(200).json({
    success: true,
    message:
      result.renewed === false
        ? "Certificate is still valid, no renewal needed"
        : "Certificate successfully issued/renewed",
    domain: result.domain,
    wildcard: result.wildcard,
    renewed: result.renewed !== false,
  });
});

/**
 * Regenerate agent certificate and update HAProxy configuration
 * This endpoint can be used to fix TLS certificate issues
 *
 * POST /api/certificates/agent/:agentId/regenerate
 */
exports.regenerateAgentCertificate = asyncHandler(async (req, res) => {
  const { agentId } = req.params;
  const { targetIp } = req.body;

  logger.info(
    `Regenerating certificates for agent ${agentId}${
      targetIp ? ` with IP ${targetIp}` : ""
    }`
  );

  // Check authorization
  if (
    !(
      req.user &&
      (req.user.role === "admin" ||
        (req.user.role === "agent" && req.user.agentId === agentId))
    )
  ) {
    throw new AppError("Unauthorized to regenerate these certificates", 403);
  }

  // Initialize certificate service if needed
  if (!coreServices.certificateService) {
    throw new AppError("Certificate service not available", 500);
  }

  if (!coreServices.certificateService.initialized) {
    logger.info("Initializing certificate service");
    await coreServices.certificateService.initialize();
  }

  try {
    // Regenerate the certificates
    const certResult =
      await coreServices.certificateService.generateAgentCertificate(
        agentId,
        targetIp
      );

    if (!certResult.success) {
      throw new AppError(
        `Failed to regenerate certificates: ${certResult.error}`,
        500
      );
    }

    // Update HAProxy configuration using the enhanced HAProxy service
    let haproxyUpdated = false;

    try {
      // Try to use the enhanced HAProxy service first
      if (
        coreServices.enhancedHAProxyService &&
        coreServices.enhancedHAProxyService.initialized
      ) {
        // Update MongoDB route using the enhanced service
        await coreServices.enhancedHAProxyService.addMongoDBRoute(
          agentId,
          targetIp || "127.0.0.1",
          27017,
          { useTls: true }
        );

        logger.info(
          `HAProxy configuration updated for agent ${agentId} using enhanced HAProxy service`
        );
        haproxyUpdated = true;
      }
      // Fallback to standard HAProxy service
      else if (
        coreServices.haproxyService &&
        coreServices.haproxyService.initialized
      ) {
        await coreServices.haproxyService.addMongoDBRoute(
          agentId,
          targetIp || "127.0.0.1",
          27017,
          { useTls: true }
        );
        logger.info(
          `HAProxy configuration updated for agent ${agentId} using standard HAProxy service`
        );
        haproxyUpdated = true;
      }
    } catch (haproxyErr) {
      logger.error(
        `Failed to update HAProxy configuration: ${haproxyErr.message}`
      );

      // Try Docker fallback approach if both service approaches failed
      try {
        // Verify config and reload HAProxy using Docker command as a fallback
        execSync(
          "docker exec haproxy haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg"
        );
        execSync("docker exec haproxy kill -SIGUSR2 1"); // Soft reload
        logger.info(
          "HAProxy configuration verified and reloaded using Docker commands"
        );
        haproxyUpdated = true;
      } catch (reloadErr) {
        logger.error(
          `Failed to reload HAProxy using Docker: ${reloadErr.message}`
        );
      }
    }

    // Return success response
    return res.status(200).json({
      success: true,
      message: `Certificates for agent ${agentId} regenerated successfully`,
      agentId,
      haproxyUpdated,
      certificatesGenerated: true,
    });
  } catch (error) {
    logger.error(`Certificate regeneration error: ${error.message}`);
    throw new AppError(
      `Failed to regenerate certificates: ${error.message}`,
      500
    );
  }
});

/**
 * Validate certificate setup for an agent
 * This endpoint checks the certificate and HAProxy configuration for an agent
 *
 * GET /api/certificates/agent/:agentId/validate
 */
exports.validateAgentCertificate = asyncHandler(async (req, res) => {
  const { agentId } = req.params;

  logger.info(`Validating certificate setup for agent ${agentId}`);

  // Check authorization
  if (
    !(
      req.user &&
      (req.user.role === "admin" ||
        (req.user.role === "agent" && req.user.agentId === agentId))
    )
  ) {
    throw new AppError("Unauthorized to validate these certificates", 403);
  }

  // Initialize certificate service if needed
  if (!coreServices.certificateService) {
    throw new AppError("Certificate service not available", 500);
  }

  if (!coreServices.certificateService.initialized) {
    logger.info("Initializing certificate service");
    await coreServices.certificateService.initialize();
  }

  try {
    // Validate the certificate setup
    const validationResult =
      await coreServices.certificateService.validateCertificateSetup(agentId);

    // If there are serious issues, set appropriate status code
    const statusCode = validationResult.success
      ? 200
      : validationResult.certificate.exists === false
      ? 404
      : 200;

    // Add remediation instructions if there are issues
    if (
      !validationResult.success &&
      validationResult.issues &&
      validationResult.issues.length > 0
    ) {
      validationResult.remediation = {
        instructions: "To fix certificate issues, try the following steps:",
        steps: [],
      };

      // Add specific remediation steps based on detected issues
      if (!validationResult.certificate.exists) {
        validationResult.remediation.steps.push(
          "Regenerate certificates by calling POST /api/certificates/agent/" +
            agentId +
            "/regenerate"
        );
      } else if (validationResult.certificate.expired) {
        validationResult.remediation.steps.push(
          "Renew the expired certificate by calling POST /api/certificates/agent/" +
            agentId +
            "/regenerate"
        );
      }

      if (
        !validationResult.haproxy.singleCertExists &&
        !validationResult.haproxy.agentCertExists
      ) {
        validationResult.remediation.steps.push(
          "Update HAProxy certificates by regenerating the certificates"
        );
      }

      if (!validationResult.haproxy.backendExists) {
        validationResult.remediation.steps.push(
          "Register MongoDB for this agent using the MongoDB registration endpoint"
        );
      }
    }

    return res.status(statusCode).json({
      ...validationResult,
      message: validationResult.success
        ? `Certificate setup for agent ${agentId} is valid`
        : `Certificate setup for agent ${agentId} has issues that need to be addressed`,
    });
  } catch (error) {
    logger.error(
      `Certificate validation error for ${agentId}: ${error.message}`
    );
    throw new AppError(
      `Failed to validate certificate setup: ${error.message}`,
      500
    );
  }
});

/**
 * Get certificate dashboard data
 * Display status of all certificates in the system
 *
 * GET /api/certificates/dashboard
 * Requires admin role
 */
exports.getCertificateDashboard = asyncHandler(async (req, res) => {
  // Check if user is authorized (admin only)
  if (!req.user || req.user.role !== "admin") {
    throw new AppError("Unauthorized - Admin access required", 403);
  }

  // Initialize certificate service if needed
  if (!coreServices.certificateService) {
    throw new AppError("Certificate service not available", 500);
  }

  if (!coreServices.certificateService.initialized) {
    await coreServices.certificateService.initialize();
  }

  logger.info("Generating certificate dashboard");

  try {
    const dashboardData =
      await coreServices.certificateService.getCertificateDashboard();

    return res.status(200).json({
      success: true,
      dashboard: dashboardData,
    });
  } catch (error) {
    logger.error(`Certificate dashboard generation error: ${error.message}`);
    throw new AppError(
      `Failed to generate certificate dashboard: ${error.message}`,
      500
    );
  }
});

/**
 * List all certificates in the system
 *
 * GET /api/certificates
 * Requires admin role
 */
exports.getAllCertificates = asyncHandler(async (req, res) => {
  // Check if user is authorized (admin only)
  if (!req.user || req.user.role !== "admin") {
    throw new AppError("Unauthorized - Admin access required", 403);
  }

  // Initialize certificate service if needed
  if (!coreServices.certificateService) {
    throw new AppError("Certificate service not available", 500);
  }

  if (!coreServices.certificateService.initialized) {
    await coreServices.certificateService.initialize();
  }

  logger.info("Listing all certificates");

  try {
    const certificates =
      await coreServices.certificateService.getAllCertificates();

    return res.status(200).json({
      success: true,
      ...certificates,
    });
  } catch (error) {
    logger.error(`Error listing certificates: ${error.message}`);
    throw new AppError(`Failed to list certificates: ${error.message}`, 500);
  }
});

/**
 * Trigger a certificate renewal check
 *
 * POST /api/certificates/renew-check
 * Requires admin role
 */
exports.runRenewalCheck = asyncHandler(async (req, res) => {
  // Check if user is authorized (admin only)
  if (!req.user || req.user.role !== "admin") {
    throw new AppError("Unauthorized - Admin access required", 403);
  }

  const { force, renewBeforeDays } = req.query;

  // Initialize services if needed
  if (!coreServices.certificateRenewalService) {
    throw new AppError("Certificate renewal service not available", 500);
  }

  if (!coreServices.certificateRenewalService.initialized) {
    await coreServices.certificateRenewalService.initialize();
  }

  logger.info(
    `Triggering certificate renewal check${force === "true" ? " (forced)" : ""}`
  );

  try {
    // Perform renewal check directly instead of waiting for schedule
    const result =
      await coreServices.certificateRenewalService.performRenewalCheck();

    // If user requested forced renewal and the normal check didn't renew everything
    if (force === "true") {
      logger.info("Forced renewal requested - renewing all certificates");

      // Directly use certificate service to force renewal of all certificates
      const forceRenewalResult =
        await coreServices.certificateService.checkAndRenewCertificates({
          forceRenewal: true,
          renewBeforeDays: renewBeforeDays ? parseInt(renewBeforeDays, 10) : 30,
        });

      return res.status(200).json({
        success: true,
        message: "Forced certificate renewal completed",
        forceRenewalResult,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Certificate renewal check completed",
      ...result,
    });
  } catch (error) {
    logger.error(`Certificate renewal check error: ${error.message}`);
    throw new AppError(
      `Failed to run certificate renewal check: ${error.message}`,
      500
    );
  }
});

/**
 * Get certificate metrics
 * Returns current metrics and trends for certificate management
 *
 * GET /api/certificates/metrics
 * Requires admin role
 */
exports.getCertificateMetrics = asyncHandler(async (req, res) => {
  // Check if user is authorized (admin only)
  if (!req.user || req.user.role !== "admin") {
    throw new AppError("Unauthorized - Admin access required", 403);
  }

  // Get metrics service
  if (!coreServices.certificateMetricsService) {
    throw new AppError("Certificate metrics service not available", 500);
  }

  logger.info("Retrieving certificate metrics");

  try {
    // Take a new snapshot to ensure current data
    const currentSnapshot =
      await coreServices.certificateMetricsService.takeMetricsSnapshot();
    const trends = coreServices.certificateMetricsService.calculateTrends();

    return res.status(200).json({
      success: true,
      metrics: currentSnapshot,
      trends,
    });
  } catch (error) {
    logger.error(`Failed to get certificate metrics: ${error.message}`);
    throw new AppError(
      `Failed to get certificate metrics: ${error.message}`,
      500
    );
  }
});

/**
 * Get historical certificate metrics
 * Returns metrics history for a specific time range
 *
 * GET /api/certificates/metrics/history
 * Requires admin role
 */
exports.getMetricsHistory = asyncHandler(async (req, res) => {
  // Check if user is authorized (admin only)
  if (!req.user || req.user.role !== "admin") {
    throw new AppError("Unauthorized - Admin access required", 403);
  }

  const { start, end } = req.query;

  if (!start || !end) {
    throw new AppError("Start and end dates are required", 400);
  }

  // Parse date strings to Date objects
  const startDate = new Date(start);
  const endDate = new Date(end);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    throw new AppError(
      "Invalid date format. Use ISO 8601 format (e.g. 2025-04-12T00:00:00Z)",
      400
    );
  }

  // Get metrics service
  if (!coreServices.certificateMetricsService) {
    throw new AppError("Certificate metrics service not available", 500);
  }

  logger.info(`Retrieving certificate metrics history from ${start} to ${end}`);

  try {
    const history = coreServices.certificateMetricsService.getMetricsHistory(
      startDate,
      endDate
    );

    return res.status(200).json({
      success: true,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      history,
    });
  } catch (error) {
    logger.error(`Failed to get metrics history: ${error.message}`);
    throw new AppError(`Failed to get metrics history: ${error.message}`, 500);
  }
});

/**
 * Get available certificate provider types
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
exports.getCertificateProviderTypes = asyncHandler(async (req, res) => {
  const providerTypes = CertificateProviderFactory.getSupportedTypes();
  res.status(200).json({
    success: true,
    providerTypes,
  });
});

/**
 * Get configuration template for a certificate provider type
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
exports.getCertificateProviderConfig = asyncHandler(async (req, res) => {
  const { providerType } = req.params;

  if (!providerType) {
    throw new AppError("Provider type is required", 400);
  }

  const configTemplate =
    CertificateProviderFactory.getConfigTemplate(providerType);

  res.status(200).json({
    success: true,
    providerType,
    configTemplate,
  });
});

/**
 * Get current certificate provider capabilities
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
exports.getCertificateProviderCapabilities = asyncHandler(async (req, res) => {
  if (!certificateService.initialized) {
    await certificateService.initialize();
  }

  const capabilities = certificateService.getProviderCapabilities() || {};

  res.status(200).json({
    success: true,
    providerType: process.env.CERT_PROVIDER_TYPE || "self-signed",
    capabilities,
  });
});

/**
 * Validate certificate provider configuration
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
exports.validateCertificateProviderConfig = asyncHandler(async (req, res) => {
  if (!certificateService.initialized) {
    await certificateService.initialize();
  }

  const validationResults = await certificateService.validateProviderConfig();

  res.status(200).json({
    success: true,
    providerType: process.env.CERT_PROVIDER_TYPE || "self-signed",
    validationResults,
  });
});
