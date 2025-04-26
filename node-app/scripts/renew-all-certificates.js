/**
 * Certificate Renewal Script
 *
 * This script forces renewal of all certificates in the system.
 * Run it with: node scripts/renew-all-certificates.js
 */

// Set up environment
require("dotenv").config();
const path = require("path");
const fs = require("fs");

// Configure logger
const logger = {
  info: (msg) => console.log(`[INFO] ${msg}`),
  error: (msg, err) => console.error(`[ERROR] ${msg}`, err || ""),
};

async function main() {
  logger.info("Starting certificate renewal process...");

  try {
    // First, make sure paths are set properly
    const pathManager = require("../utils/pathManager");
    await pathManager.initialize();

    // Import the certificate service
    const CertificateService = require("../services/core/certificateService");
    const certificateService = new CertificateService();

    // Initialize the service
    logger.info("Initializing certificate service...");
    await certificateService.initialize();

    // Force renewal of all certificates
    logger.info("Forcing renewal of all certificates...");
    const result = await certificateService.checkAndRenewCertificates({
      forceRenewal: true,
      renewBeforeDays: 30,
    });

    // Log the result
    logger.info("Certificate renewal complete!");
    logger.info(`Renewed certificates: ${result.renewed.length}`);
    logger.info(`Failed renewals: ${result.failed.length}`);

    if (result.renewed.length > 0) {
      logger.info("Successfully renewed:");
      result.renewed.forEach((cert) => {
        logger.info(`- ${cert.domain || cert.name}`);
      });
    }

    if (result.failed.length > 0) {
      logger.info("Failed to renew:");
      result.failed.forEach((cert) => {
        logger.info(`- ${cert.domain || cert.name}: ${cert.error}`);
      });
    }

    process.exit(0);
  } catch (error) {
    logger.error("Certificate renewal failed:", error);
    process.exit(1);
  }
}

// Run the script
main().catch((error) => {
  logger.error("Unhandled error:", error);
  process.exit(1);
});
