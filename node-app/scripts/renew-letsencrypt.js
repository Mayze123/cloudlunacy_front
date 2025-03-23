#!/usr/bin/env node
/**
 * Let's Encrypt Certificate Renewal Script
 *
 * This script initiates renewal of Let's Encrypt certificates for the MongoDB domain.
 * Can be executed manually or as a scheduled cron job.
 */

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const logger = require("../utils/logger").getLogger("letsencrypt-renewal");
const LetsEncryptManager = require("../services/core/letsencryptManager");
const configManager = require("../services/core/configManager");
const pathManager = require("../utils/pathManager");

/**
 * Verify required environment variables are set
 * @returns {boolean} True if all required variables are set
 */
function verifyEnvironmentVariables() {
  const requiredVars = [
    "CF_EMAIL",
    "CF_API_KEY",
    "CF_DNS_API_TOKEN",
    "CF_ZONE_API_TOKEN",
  ];

  const missing = requiredVars.filter((varName) => !process.env[varName]);

  if (missing.length > 0) {
    logger.error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
    return false;
  }

  return true;
}

// Wait for the process to be fully initialized
process.nextTick(async () => {
  try {
    logger.info("Starting Let's Encrypt certificate renewal script");

    // Verify environment variables
    if (!verifyEnvironmentVariables()) {
      logger.error(
        "Certificate renewal aborted due to missing environment variables"
      );
      process.exit(1);
    }

    // Initialize path manager
    await pathManager.initialize();

    // Initialize config manager
    await configManager.initialize();

    // Create Let's Encrypt manager
    const letsencryptManager = new LetsEncryptManager(configManager);

    try {
      await letsencryptManager.initialize();
    } catch (initErr) {
      logger.error(
        `Failed to initialize Let's Encrypt manager: ${initErr.message}`,
        {
          error: initErr.message,
          stack: initErr.stack,
        }
      );
      process.exit(1);
    }

    // Force renewal if --force flag is provided
    const forceRenewal = process.argv.includes("--force");
    const dryRun = process.argv.includes("--dry-run");

    if (dryRun) {
      logger.info("Running in dry-run mode - no changes will be made");
      const needsRenewal = await letsencryptManager.needsRenewal();
      logger.info(
        `Certificate renewal ${needsRenewal ? "is" : "is not"} needed`
      );
      process.exit(0);
    }

    let result;
    if (forceRenewal) {
      logger.info("Forcing certificate renewal");
      result = await letsencryptManager.issueCertificates();
    } else {
      logger.info("Checking if certificate renewal is needed");
      result = await letsencryptManager.renewIfNeeded();
    }

    if (result.renewed === false) {
      logger.info(
        `Certificate is still valid, no renewal needed (expires: ${
          result.expiryDate || "unknown"
        })`
      );
    } else {
      logger.info(
        `Certificate successfully renewed for domains: ${
          result.domains?.join(", ") || result.domain
        }`
      );
    }

    // Reload HAProxy if certificate was renewed
    if (result.renewed !== false) {
      try {
        const { execAsync } = require("../utils/exec");
        logger.info("Reloading HAProxy to apply new certificate");
        const haproxyContainer = process.env.HAPROXY_CONTAINER || "haproxy";
        await execAsync(
          `docker kill -s HUP ${haproxyContainer} || docker restart ${haproxyContainer}`
        );
        logger.info("HAProxy reloaded successfully");
      } catch (err) {
        logger.error(`Failed to reload HAProxy: ${err.message}`, {
          error: err.message,
          stack: err.stack,
        });
        process.exit(1);
      }
    }

    logger.info("Certificate renewal script completed successfully");
    process.exit(0);
  } catch (err) {
    logger.error(`Certificate renewal failed: ${err.message}`, {
      error: err.message,
      stack: err.stack,
    });
    process.exit(1);
  }
});
