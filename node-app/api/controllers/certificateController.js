/**
 * Certificate Controller
 */
const fs = require("fs").promises;
const path = require("path");
const logger = require("../../utils/logger").getLogger("certificateController");

// Path to MongoDB CA certificate
const MONGO_CA_PATH =
  process.env.MONGO_CA_PATH || "/app/config/certs/mongodb-ca.crt";

/**
 * Get MongoDB CA certificate
 */
exports.getMongoCA = async (req, res) => {
  try {
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
