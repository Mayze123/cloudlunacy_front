/**
 * Certificate Controller
 */
const fs = require("fs").promises;
const logger = require("../../utils/logger").getLogger("certificateController");
const coreServices = require("../../services/core");
const { asyncHandler, AppError } = require("../../utils/errorHandler");
const pathManager = require("../../utils/pathManager");
const { execSync } = require("child_process");

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

    // Check if HAProxy template-based configuration is available
    let haproxyUpdated = false;
    if (coreServices.haproxyConfigManager) {
      try {
        // Ensure HAProxy configuration is up to date using the template system
        const configData = {
          statsPassword: "admin_password",
          includeHttp: true,
          includeMongoDB: true,
          useSsl: true,
          sslCertPath: "/etc/ssl/certs/mongodb.pem",
          mongoDBServers: coreServices.haproxyManager?.mongoDBServers || [],
        };

        await coreServices.haproxyConfigManager.saveConfig(configData);
        await coreServices.haproxyConfigManager.applyConfig();

        logger.info("HAProxy configuration updated using template system");
        haproxyUpdated = true;
      } catch (configError) {
        logger.error(
          `Template-based HAProxy config update failed: ${configError.message}`
        );
      }
    }

    // Fall back to HAProxy manager if template system failed
    if (!haproxyUpdated && coreServices.haproxyManager) {
      try {
        // Update HAProxy configuration using the HAProxy manager
        await coreServices.haproxyManager.updateMongoDBBackend(
          agentId,
          targetIp || "127.0.0.1",
          27017
        );

        // Try to reload HAProxy using Docker command as a fallback
        try {
          execSync(
            "docker exec haproxy-dev haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg"
          );
          execSync("docker exec haproxy-dev service haproxy reload");
          logger.info(
            "HAProxy configuration verified and reloaded using Docker commands"
          );
          haproxyUpdated = true;
        } catch (reloadErr) {
          logger.error(
            `Failed to reload HAProxy using Docker: ${reloadErr.message}`
          );
        }
      } catch (managerError) {
        logger.error(`HAProxy manager update failed: ${managerError.message}`);
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
