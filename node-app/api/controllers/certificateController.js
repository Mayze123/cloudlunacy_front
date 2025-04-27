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
      // Try to use MongoDB service first
      if (
        coreServices.mongodbService &&
        coreServices.mongodbService.initialized
      ) {
        // Update MongoDB route using the MongoDB service
        await coreServices.mongodbService.registerAgent(
          agentId,
          targetIp || "127.0.0.1",
          27017,
          { useTls: true }
        );

        logger.info(
          `MongoDB registration updated for agent ${agentId} using MongoDB service`
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
 * Get certificate dashboard
 * Shows status of all certificates in the system
 */
exports.getCertificateDashboard = async (req, res) => {
  try {
    const dashboardData = await certificateService.getDashboardData();
    res.json({
      success: true,
      data: dashboardData,
    });
  } catch (error) {
    logger.error(`Error getting certificate dashboard: ${error.message}`);
    throw new AppError("Failed to get certificate dashboard", 500);
  }
};

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

/**
 * Get certificate dashboard data
 * Display status of all certificates in the system
 *
 * GET /api/certificates/dashboard
 * Requires admin role
 */
exports.getDashboardData = asyncHandler(async (req, res) => {
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
 * List all certificates in the system (public version)
 * This endpoint doesn't require authentication but returns limited information
 *
 * GET /api/certificates/public
 */
exports.getPublicCertificateList = asyncHandler(async (req, res) => {
  // Initialize certificate service if needed
  if (!coreServices.certificateService) {
    throw new AppError("Certificate service not available", 500);
  }

  if (!coreServices.certificateService.initialized) {
    await coreServices.certificateService.initialize();
  }

  logger.info("Listing public certificates");

  try {
    const certificates =
      await coreServices.certificateService.getAllCertificates();

    // Filter sensitive information
    const filteredCertificates = certificates.certificates.map((cert) => ({
      agentId: cert.agentId,
      exists: cert.exists,
      expiry: cert.expiry,
      daysRemaining: cert.daysRemaining,
      isExpired: cert.isExpired,
    }));

    return res.status(200).json({
      success: true,
      count: filteredCertificates.length,
      certificates: filteredCertificates,
    });
  } catch (error) {
    logger.error(`Error listing public certificates: ${error.message}`);
    throw new AppError(`Failed to list certificates: ${error.message}`, 500);
  }
});

/**
 * Temporary endpoint for renewing all certificates
 */
exports.tempRenewAll = asyncHandler(async (req, res) => {
  try {
    // Ensure certificate service is initialized
    if (!coreServices.certificateService) {
      throw new AppError("Certificate service not available", 500);
    }

    if (!coreServices.certificateService.initialized) {
      await coreServices.certificateService.initialize();
    }

    // Get the certificates path from the certificate service
    const certsPath = coreServices.certificateService.certsDir;
    const agentsPath = path.join(certsPath, "agents");
    const configPath = path.dirname(certsPath);

    // Check what directories and files exist
    const debugInfo = {
      certsPath,
      agentsPath,
      configPath,
      directories: {},
      foundCertificates: [],
      pathManagerInitialized: pathManager.initialized,
      certificateServiceInitialized:
        coreServices.certificateService.initialized,
      serviceConfig: {
        certsDir: coreServices.certificateService.certsDir,
        useHaproxy: !!process.env.USE_HAPROXY,
        caPath: coreServices.certificateService.caCertPath,
        caKeyPath: coreServices.certificateService.caKeyPath,
        autoRenew: process.env.AUTO_RENEW_CERTIFICATES !== "false",
      },
    };

    // List directories to help diagnose certificate issues
    try {
      debugInfo.directories.certs = await fs.readdir(certsPath);
    } catch (err) {
      debugInfo.directories.certs = `Error: ${err.message}`;
    }

    try {
      debugInfo.directories.agents = await fs.readdir(agentsPath);
    } catch (err) {
      debugInfo.directories.agents = `Error: ${err.message}`;
    }

    try {
      debugInfo.directories.config = await fs.readdir(configPath);
    } catch (err) {
      debugInfo.directories.config = `Error: ${err.message}`;
    }

    // Check if there's an alternative agents directory in some installations
    try {
      const altAgentsPath = path.join(process.cwd(), "config", "agents");
      debugInfo.directories.altAgents = await fs.readdir(altAgentsPath);
    } catch (err) {
      debugInfo.directories.altAgents = [];
    }

    // Double-check config certs directory
    try {
      const configCertsPath = path.join(configPath, "certs");
      debugInfo.directories.configCerts = await fs.readdir(configCertsPath);
    } catch (err) {
      debugInfo.directories.configCerts = `Error: ${err.message}`;
    }

    // Force a renewal check on all certificates using the consolidated certificate service
    logger.info("Running certificate renewal check for all agents");
    const result =
      await coreServices.certificateService.checkAndRenewCertificates({
        forceRenewal: req.query.force === "true",
        renewBeforeDays: req.query.days ? parseInt(req.query.days, 10) : 30,
      });

    // Return result with the debug information
    res.status(200).json({
      success: true,
      message: "Certificate operation completed",
      result,
      debugInfo,
    });
  } catch (err) {
    logger.error(`Error processing certificate temp-renew: ${err.message}`);
    throw new AppError(`Certificate service error: ${err.message}`, 500);
  }
});

/**
 * Temporary endpoint for regenerating agent certificate without authentication
 * This is for debugging purposes only and should be removed in production
 *
 * POST /api/certificates/temp-regenerate/:agentId
 */
exports.tempRegenerateAgentCertificate = asyncHandler(async (req, res) => {
  const { agentId } = req.params;
  const { targetIp } = req.body || {};

  logger.info(
    `[TEMP] Regenerating certificates for agent ${agentId}${
      targetIp ? ` with IP ${targetIp}` : ""
    }`
  );

  // Initialize certificate service if needed
  if (!coreServices.certificateService) {
    throw new AppError("Certificate service not available", 500);
  }

  if (!coreServices.certificateService.initialized) {
    logger.info("Initializing certificate service");
    await coreServices.certificateService.initialize();
  }

  try {
    // Create an enhanced OpenSSL config with proper key usage bits for MongoDB Compass
    // We'll modify the certificate generation within the service temporarily
    const originalCreateCertificateForAgent =
      coreServices.certificateService.createCertificateForAgent;

    // Override the method to use enhanced OpenSSL config
    coreServices.certificateService.createCertificateForAgent = async function (
      agentId,
      targetIp
    ) {
      // Create a resource-specific lock ID
      const lockId = `${CERTIFICATE_LOCK_PREFIX}_${agentId}`;

      try {
        if (!this.initialized) {
          await this.initialize();
        }

        logger.info(
          `Requesting certificate generation lock for agent ${agentId}`
        );

        // Acquire lock to prevent race conditions with parallel certificate operations
        return await FileLock.withLock(
          lockId,
          async () => {
            logger.info(
              `Creating certificate for agent ${agentId} with enhanced key usage bits`
            );

            // Determine writable agent certificate directory (fall back if bind mount is read-only)
            let agentCertDir = path.join(this.certsDir, "agents", agentId);
            await fs.mkdir(agentCertDir, { recursive: true });

            // Test writability
            let writable = true;
            try {
              await fs.access(agentCertDir, fsSync.constants.W_OK);
            } catch {
              writable = false;
            }

            if (!writable) {
              logger.warn(
                `Agent cert dir ${agentCertDir} not writable, using local fallback`
              );
              agentCertDir = path.join(this.localCertsDir, agentId);
              await fs.mkdir(agentCertDir, { recursive: true });
            }

            // Ensure directory permissions where possible
            try {
              await fs.chmod(agentCertDir, 0o755);
            } catch (chmodErr) {
              logger.warn(
                `Could not set permissions for agent cert directory: ${chmodErr.message}`
              );
            }

            logger.info(`Using agent cert directory: ${agentCertDir}`);

            // Define paths
            const keyPath = path.join(agentCertDir, "server.key");
            const csrPath = path.join(agentCertDir, "server.csr");
            const certPath = path.join(agentCertDir, "server.crt");
            const pemPath = path.join(agentCertDir, "server.pem");
            const tempKeyPath = path.join(agentCertDir, ".server.key.tmp");
            const tempCertPath = path.join(agentCertDir, ".server.crt.tmp");
            const tempPemPath = path.join(agentCertDir, ".server.pem.tmp");
            const configPath = path.join(os.tmpdir(), `openssl_${agentId}.cnf`);
            const mongoSubdomain = `${agentId}.${this.mongoDomain}`;

            // Validate IP address to prevent OpenSSL errors
            const isValidIP = (ip) => {
              if (!ip || typeof ip !== "string") return false;
              // IPv4 validation
              const ipv4Regex =
                /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
              return ipv4Regex.test(ip);
            };

            // Create OpenSSL configuration with proper IP handling and key usage bits for MongoDB Compass
            let opensslConfig = `
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = ${mongoSubdomain}

[v3_req]
# These key usage settings are critical for MongoDB Compass compatibility
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment, nonRepudiation, dataEncipherment, keyAgreement
extendedKeyUsage = serverAuth, clientAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = ${mongoSubdomain}
DNS.2 = localhost
`;

            // Add IP address if valid
            if (isValidIP(targetIp)) {
              opensslConfig += `IP.1 = ${targetIp}\n`;
            }
            opensslConfig += `IP.2 = 127.0.0.1\n`;

            // Write OpenSSL configuration
            await fs.writeFile(configPath, opensslConfig);

            // Ensure CA key and certificate are accessible
            // If originals can't be accessed, attempt to use fallback copies
            let effectiveCaCertPath = this.caCertPath;
            let effectiveCaKeyPath = this.caKeyPath;

            // First check if we have existing local copies of CA files
            let localCopiesExist = false;
            try {
              await fs.access(this.localCaCertPath, fsSync.constants.R_OK);
              await fs.access(this.localCaKeyPath, fsSync.constants.R_OK);
              localCopiesExist = true;
            } catch (accessErr) {
              localCopiesExist = false;
            }

            // Then check if the original CA files are accessible
            let originalFilesAccessible = true;
            try {
              await fs.access(this.caCertPath, fsSync.constants.R_OK);
              await fs.access(this.caKeyPath, fsSync.constants.R_OK);
            } catch (accessErr) {
              originalFilesAccessible = false;
            }

            // If we can access originals but don't have local copies, create them
            if (originalFilesAccessible && !localCopiesExist) {
              try {
                // Copy to local fallback location
                await fs.copyFile(this.caCertPath, this.localCaCertPath);
                await fs.copyFile(this.caKeyPath, this.localCaKeyPath);
                await fs.chmod(this.localCaCertPath, 0o644);
                await fs.chmod(this.localCaKeyPath, 0o600);
                logger.info(
                  "Copied CA files to fallback location for future use"
                );
              } catch (copyErr) {
                logger.warn(
                  `Failed to create fallback copies of CA files: ${copyErr.message}`
                );
              }
            }

            // If original CA files aren't accessible but we have local copies, use those
            if (!originalFilesAccessible && localCopiesExist) {
              logger.info(
                "Using local fallback copies of CA files due to permission issues"
              );
              effectiveCaCertPath = this.localCaCertPath;
              effectiveCaKeyPath = this.localCaKeyPath;
            }

            // If neither originals nor local copies are accessible, try to create new ones
            if (!originalFilesAccessible && !localCopiesExist) {
              try {
                logger.warn(
                  "Cannot access CA files, creating temporary CA certificates"
                );
                // Generate a temporary CA key and certificate
                await fs.mkdir(path.dirname(this.localCaKeyPath), {
                  recursive: true,
                });
                // Generate CA private key
                execSync(`openssl genrsa -out ${this.localCaKeyPath} 2048`);
                // Generate CA certificate
                execSync(
                  `openssl req -x509 -new -nodes -key ${this.localCaKeyPath} -sha256 -days 3650 -out ${this.localCaCertPath} -subj "/CN=CloudLunacy Temp CA/O=CloudLunacy/C=UK"`
                );
                // Set proper permissions
                await fs.chmod(this.localCaKeyPath, 0o600);
                await fs.chmod(this.localCaCertPath, 0o644);
                logger.info(
                  "Temporary CA certificate and key generated successfully"
                );
                // Use the temporary CA files for certificate generation
                effectiveCaCertPath = this.localCaCertPath;
                effectiveCaKeyPath = this.localCaKeyPath;
                localCopiesExist = true;
              } catch (genErr) {
                logger.error(
                  `Failed to generate temporary CA: ${genErr.message}`
                );
                throw new Error(
                  "Cannot access CA files and failed to create temporary CA"
                );
              }
            }

            // If we still don't have usable CA files, throw error
            if (!originalFilesAccessible && !localCopiesExist) {
              throw new Error(
                "Cannot access CA files and no fallback copies exist"
              );
            }

            try {
              // Generate private key to temporary file first
              execSync(`openssl genrsa -out ${tempKeyPath} 2048`);

              // Generate CSR
              execSync(
                `openssl req -new -key ${tempKeyPath} -out ${csrPath} -config ${configPath}`
              );

              // Sign certificate with CA
              // Determine CA serial option: fallback to local serial file if certsDir is read-only
              let caSerialOption = "-CAcreateserial";
              if (agentCertDir.startsWith(this.localCertsDir)) {
                const localSerial = path.join(this.localCertsDir, "ca.srl");
                try {
                  await fs.access(localSerial);
                } catch {
                  await fs.writeFile(localSerial, "01");
                }
                caSerialOption = `-CAserial ${localSerial}`;
              }

              execSync(
                `openssl x509 -req -in ${csrPath} -CA ${effectiveCaCertPath} -CAkey ${effectiveCaKeyPath} ${caSerialOption} -out ${tempCertPath} -days 365 -extensions v3_req -extfile ${configPath}`
              );

              // Create combined PEM file
              const certContent = await fs.readFile(tempCertPath, "utf8");
              const keyContent = await fs.readFile(tempKeyPath, "utf8");
              const pemContent = certContent + keyContent;
              await fs.writeFile(tempPemPath, pemContent);

              // Set permissions
              await fs.chmod(tempKeyPath, 0o600);
              await fs.chmod(tempCertPath, 0o644);
              await fs.chmod(tempPemPath, 0o600);

              // Atomically move temporary files to final locations
              await fs.rename(tempKeyPath, keyPath);
              await fs.rename(tempCertPath, certPath);
              await fs.rename(tempPemPath, pemPath);

              // Certificate created successfully
              logger.info(`Enhanced certificate created for agent ${agentId}`);
              return {
                success: true,
                keyPath,
                certPath,
                pemPath,
                caPath: this.caCertPath,
                enhancedKeyUsage: true,
              };
            } catch (err) {
              // Clean up temporary files if they exist
              try {
                await fs.unlink(tempKeyPath).catch(() => {});
                await fs.unlink(tempCertPath).catch(() => {});
                await fs.unlink(tempPemPath).catch(() => {});
              } catch (cleanupErr) {
                logger.warn(
                  `Failed to clean up temporary files: ${cleanupErr.message}`
                );
              }
              throw err;
            }
          },
          60000 // Increased from 15000 to 60000 (60 seconds) to accommodate slower systems
        );
      } catch (err) {
        if (err.message.includes("Could not acquire lock")) {
          logger.error(
            `Lock acquisition timeout for agent ${agentId} certificate generation`
          );
          return {
            success: false,
            error: `Certificate generation already in progress for agent ${agentId}. Try again later.`,
            transient: true,
          };
        }

        logger.error(
          `Failed to create certificate for agent ${agentId}: ${err.message}`,
          {
            error: err.message,
            stack: err.stack,
          }
        );

        return {
          success: false,
          error: err.message,
        };
      }
    };

    // Regenerate the certificates with the enhanced key usage
    logger.info(
      `[TEMP] Generating certificates with enhanced key usage bits for agent ${agentId}`
    );
    const certResult =
      await coreServices.certificateService.generateAgentCertificate(
        agentId,
        targetIp
      );

    // Restore the original method after certificate generation
    coreServices.certificateService.createCertificateForAgent =
      originalCreateCertificateForAgent;

    if (!certResult.success) {
      throw new AppError(
        `Failed to regenerate certificates: ${certResult.error}`,
        500
      );
    }

    // Update HAProxy configuration if we can
    let haproxyUpdated = false;
    try {
      if (
        coreServices.mongodbService &&
        coreServices.mongodbService.initialized
      ) {
        await coreServices.mongodbService.registerAgent(
          agentId,
          targetIp || "127.0.0.1",
          27017,
          { useTls: true }
        );
        logger.info(`MongoDB registration updated for agent ${agentId}`);
        haproxyUpdated = true;
      } else if (
        coreServices.haproxyService &&
        coreServices.haproxyService.initialized
      ) {
        await coreServices.haproxyService.addMongoDBRoute(
          agentId,
          targetIp || "127.0.0.1",
          27017,
          { useTls: true }
        );
        logger.info(`HAProxy configuration updated for agent ${agentId}`);
        haproxyUpdated = true;
      }
    } catch (haproxyErr) {
      logger.warn(
        `Failed to update HAProxy configuration: ${haproxyErr.message}`
      );
      // We will continue even if HAProxy update fails - the certificate is the important part
    }

    // Return success response
    return res.status(200).json({
      success: true,
      message: `Certificates for agent ${agentId} regenerated successfully with enhanced key usage bits for MongoDB Compass`,
      agentId,
      haproxyUpdated,
      certificatesGenerated: true,
      enhancedCertificate: true,
      note: "This certificate has enhanced key usage bits for MongoDB Compass compatibility",
    });
  } catch (error) {
    logger.error(`Certificate regeneration error: ${error.message}`);
    throw new AppError(
      `Failed to regenerate certificates: ${error.message}`,
      500
    );
  }
});
