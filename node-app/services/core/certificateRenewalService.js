/**
 * Certificate Renewal Service
 *
 * Handles automatic certificate renewal on a scheduled basis
 */

const logger = require("../../utils/logger").getLogger("certRenewalService");
const FileLock = require("../../utils/fileLock");

const RENEWAL_LOCK = "cert_renewal_process";
const DEFAULT_CHECK_INTERVAL_MINUTES = 1440; // Default to once per day
const DEFAULT_RENEWAL_THRESHOLD_DAYS = 30; // Renew certificates with 30 or fewer days remaining

class CertificateRenewalService {
  constructor(certificateService) {
    this.certificateService = certificateService;
    this.initialized = false;
    this.renewalInterval = null;
    this.checkIntervalMinutes = process.env.CERT_CHECK_INTERVAL_MINUTES
      ? parseInt(process.env.CERT_CHECK_INTERVAL_MINUTES, 10)
      : DEFAULT_CHECK_INTERVAL_MINUTES;
    this.renewalThresholdDays = process.env.CERT_RENEWAL_THRESHOLD_DAYS
      ? parseInt(process.env.CERT_RENEWAL_THRESHOLD_DAYS, 10)
      : DEFAULT_RENEWAL_THRESHOLD_DAYS;
  }

  /**
   * Initialize the certificate renewal service
   */
  async initialize() {
    try {
      logger.info("Initializing certificate renewal service");

      // Make sure certificate service is initialized
      if (this.certificateService && !this.certificateService.initialized) {
        await this.certificateService.initialize();
      }

      this.initialized = true;
      logger.info("Certificate renewal service initialized successfully");

      // Schedule a renewal check if enabled
      if (process.env.AUTO_RENEW_CERTIFICATES !== "false") {
        this.startRenewalSchedule();
      }

      return true;
    } catch (err) {
      logger.error(
        `Failed to initialize certificate renewal service: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
        }
      );
      return false;
    }
  }

  /**
   * Start the schedule for certificate renewal checks
   * @param {number} intervalMinutes - Interval in minutes between renewal checks
   */
  startRenewalSchedule(intervalMinutes = null) {
    // Clear any existing interval
    if (this.renewalInterval) {
      clearInterval(this.renewalInterval);
      this.renewalInterval = null;
    }

    // Set interval from parameter or use the default
    const checkInterval =
      (intervalMinutes || this.checkIntervalMinutes) * 60 * 1000;

    logger.info(
      `Starting certificate renewal schedule with interval of ${
        checkInterval / 60 / 1000
      } minutes`
    );

    // Run an initial check right away, but wait a minute for system to stabilize
    setTimeout(() => {
      this.performRenewalCheck().catch((err) => {
        logger.error(
          `Error during initial certificate renewal check: ${err.message}`,
          {
            error: err.message,
            stack: err.stack,
          }
        );
      });
    }, 60 * 1000);

    // Schedule regular checks
    this.renewalInterval = setInterval(() => {
      this.performRenewalCheck().catch((err) => {
        logger.error(
          `Error during scheduled certificate renewal check: ${err.message}`,
          {
            error: err.message,
            stack: err.stack,
          }
        );
      });
    }, checkInterval);

    return true;
  }

  /**
   * Stop the renewal schedule
   */
  stopRenewalSchedule() {
    if (this.renewalInterval) {
      clearInterval(this.renewalInterval);
      this.renewalInterval = null;
      logger.info("Certificate renewal schedule stopped");
      return true;
    }
    return false;
  }

  /**
   * Perform a certificate renewal check
   * @returns {Promise<Object>} Results of the renewal check
   */
  async performRenewalCheck() {
    // Use a lock to prevent multiple simultaneous renewal checks
    const lockResult = await FileLock.acquire(RENEWAL_LOCK, 30000);

    if (!lockResult.success) {
      logger.info(
        "Another renewal process is already running, skipping this one"
      );
      return {
        success: false,
        error: "Another renewal process is already running",
      };
    }

    try {
      logger.info("Starting scheduled certificate renewal check");

      // Check and renew certificates that are expiring soon
      const result = await this.certificateService.checkAndRenewCertificates({
        renewBeforeDays: this.renewalThresholdDays,
      });

      // Log results summary
      if (result.renewed && result.renewed.length > 0) {
        logger.info(`Renewed ${result.renewed.length} certificates`);

        // Log detailed renewal information
        for (const cert of result.renewed) {
          logger.info(
            `Renewed certificate for agent ${cert.agentId} (had ${cert.daysRemaining} days remaining)`
          );
        }
      } else {
        logger.info("No certificates needed renewal");
      }

      // Log failures
      if (result.failed && result.failed.length > 0) {
        logger.warn(`Failed to renew ${result.failed.length} certificates`);

        for (const cert of result.failed) {
          logger.warn(
            `Failed to renew certificate for agent ${cert.agentId}: ${cert.error}`
          );
        }
      }

      return result;
    } catch (err) {
      logger.error(`Error during certificate renewal check: ${err.message}`);

      return {
        success: false,
        error: err.message,
      };
    } finally {
      // Always release the lock
      await lockResult.lock.release();
    }
  }
}

module.exports = CertificateRenewalService;
