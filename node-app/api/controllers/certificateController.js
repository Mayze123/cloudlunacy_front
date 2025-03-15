/**
 * Certificate Controller
 */
const fs = require("fs").promises;
const path = require("path");
const logger = require("../../utils/logger").getLogger("certificateController");
const coreServices = require("../../services/core");

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
    } catch (err) {
      logger.warn(
        `Failed to read MongoDB CA certificate from ${MONGO_CA_PATH}: ${err.message}`
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
exports.getAgentCertificates = async (req, res) => {
  try {
    const { agentId } = req.params;

    // Check if user is authorized to access these certificates
    if (
      req.user &&
      (req.user.role === "admin" ||
        (req.user.role === "agent" && req.user.agentId === agentId))
    ) {
      // Initialize certificate service if needed
      if (!coreServices.certificate || !coreServices.certificate.initialized) {
        await coreServices.certificate.initialize();
      }

      const certResult =
        await coreServices.certificate.generateAgentCertificate(agentId);

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
        return res.status(500).json({
          success: false,
          message: "Failed to generate agent certificates",
          error: certResult.error,
        });
      }
    } else {
      return res.status(403).json({
        success: false,
        message: "Unauthorized to access these certificates",
      });
    }
  } catch (err) {
    logger.error(`Failed to get agent certificates: ${err.message}`, {
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json({
      success: false,
      message: "Failed to get agent certificates",
      error: err.message,
    });
  }
};
