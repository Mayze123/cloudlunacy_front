/**
 * Certificate Controller
 */
const fs = require("fs").promises;
const logger = require("../../utils/logger").getLogger("certificateController");
const coreServices = require("../../services/core");
const { asyncHandler } = require("../../utils/asyncHandler");
const { AppError } = require("../../utils/appError");

// Path to MongoDB CA certificate
const MONGO_CA_PATH =
  process.env.MONGO_CA_PATH || "/app/config/certs/mongodb-ca.crt";

/**
 * Get MongoDB CA certificate
 */
exports.getMongoCA = async (req, res) => {
  try {
    // Check if certificate service is available
    if (coreServices.certificate && coreServices.certificate.initialized) {
      const caResult = await coreServices.certificate.getCA();

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
        details: "The server is not configured with a MongoDB CA certificate",
      });
    }

    res.set("Content-Type", "application/x-pem-file");
    res.set("Content-Disposition", 'attachment; filename="mongodb-ca.crt"');
    res.send(caCert);
  } catch (err) {
    logger.error(`Failed to get MongoDB CA certificate: ${err.message}`, {
      error: err.message,
      stack: err.stack,
    });
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
  logger.info(`Generating certificates for agent ${agentId}`);

  // Check if user is authorized to access these certificates
  if (
    req.user &&
    (req.user.role === "admin" ||
      (req.user.role === "agent" && req.user.agentId === agentId))
  ) {
    // Initialize certificate service if needed
    if (!coreServices.certificate) {
      throw new AppError("Certificate service not available", 500);
    }

    if (!coreServices.certificate.initialized) {
      logger.info("Initializing certificate service");
      await coreServices.certificate.initialize();
    }

    logger.info(`Generating certificate for agent ${agentId}`);
    const certResult = await coreServices.certificate.generateAgentCertificate(
      agentId
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
