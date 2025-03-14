/**
 * Certificate Controller
 */
const certificateService = require("../../services/core/certificateService");
const logger = require("../../utils/logger");

/**
 * Get MongoDB CA certificate
 */
exports.getMongoCA = async (req, res) => {
  try {
    const caCert = await certificateService.getMongoCA();

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
