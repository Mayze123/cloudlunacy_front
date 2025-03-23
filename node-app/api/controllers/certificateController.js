/**
 * Certificate Controller
 */
const fs = require("fs").promises;
const logger = require("../../utils/logger").getLogger("certificateController");
const coreServices = require("../../services/core");
const { asyncHandler, AppError } = require("../../utils/errorHandler");
const pathManager = require("../../utils/pathManager");

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
    const certResult =
      await coreServices.certificateService.generateAgentCertificate(
        agentId,
        targetIp
      );

    logger.info(
      `Certificate generation result: ${JSON.stringify({
        success: certResult.success,
        error: certResult.error || null,
      })}`
    );

    if (certResult.success) {
      return res.status(200).json({
        success: true,
        agentId,
        certificates: {
          caCert: certResult.caCert,
          serverKey: certResult.serverKey,
          serverCert: certResult.serverCert,
        },
      });
    } else {
      throw new AppError(
        `Failed to generate agent certificates: ${certResult.error}`,
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
