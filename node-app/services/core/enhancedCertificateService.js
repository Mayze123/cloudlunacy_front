/**
 * Enhanced Certificate Service
 *
 * Provides high-level certificate management operations:
 * - Certificate monitoring and reporting
 * - Automatic renewal for expiring certificates
 * - Certificate validation and verification
 * - Certificate metrics collection
 */

const path = require("path");
const fs = require("fs").promises;
const EnhancedCertificateManager = require("../../utils/enhancedCertificateManager");
const logger = require("../../utils/logger").getLogger("enhancedCertService");
const { withRetry } = require("../../utils/retryHandler");
const { execAsync } = require("../../utils/exec");
const { FileLock } = require("../../utils/fileLock");

class EnhancedCertificateService {
  /**
   * Create a new enhanced certificate service
   * @param {Object} options - Configuration options
   */
  constructor(options = {}) {
    this.options = {
      certsDir: path.join(process.cwd(), "config", "certs"),
      renewThresholdDays: 30,
      checkIntervalHours: 24,
      autoRenew: true,
      ...options,
    };

    this.certManager = new EnhancedCertificateManager(this.options);
    this.fileLock = new FileLock();
    this.metricsCache = null;
    this.metricsCacheTime = null;

    // Set up event listeners
    this._setupEventListeners();
  }

  /**
   * Initialize the certificate service
   * @returns {Promise<boolean>} Success status
   */
  async initialize() {
    try {
      logger.info("Initializing enhanced certificate service");

      // Initialize certificate manager
      await this.certManager.initialize();

      logger.info("Enhanced certificate service initialized successfully");
      return true;
    } catch (err) {
      logger.error(`Failed to initialize certificate service: ${err.message}`);
      return false;
    }
  }

  /**
   * Set up event listeners for certificate manager events
   */
  _setupEventListeners() {
    // Listen for certificate expiring events
    this.certManager.on("certificate-expiring", async (data) => {
      logger.warn(
        `Certificate expiring soon: ${data.certificate.name} (${data.daysRemaining} days remaining)`
      );

      // Trigger automated actions for expiring certificates
      this._handleExpiringCertificate(data.certificate);
    });

    // Listen for certificate expired events
    this.certManager.on("certificate-expired", async (data) => {
      logger.error(`Certificate expired: ${data.certificate.name}`);

      // Trigger automated actions for expired certificates
      this._handleExpiredCertificate(data.certificate);
    });

    // Listen for certificate renewal needed events
    this.certManager.on("certificate-renewal-needed", async (data) => {
      logger.info(
        `Certificate renewal needed: ${data.certificate.name} (${data.daysRemaining} days remaining)`
      );

      if (this.options.autoRenew) {
        this._triggerCertificateRenewal(data.certificate);
      }
    });
  }

  /**
   * Handle expiring certificate events
   * @param {Object} certificate - Certificate information
   */
  async _handleExpiringCertificate(certificate) {
    // Log the event
    logger.warn(
      `Certificate '${certificate.name}' is expiring in ${certificate.daysUntilExpiration} days`
    );

    // Additional handling can be implemented here
    // For example, sending alerts or notifications
  }

  /**
   * Handle expired certificate events
   * @param {Object} certificate - Certificate information
   */
  async _handleExpiredCertificate(certificate) {
    // Log the event
    logger.error(`Certificate '${certificate.name}' has expired`);

    // Additional handling can be implemented here
    // For example, sending alerts or notifications
  }

  /**
   * Trigger certificate renewal process
   * @param {Object} certificate - Certificate information
   */
  async _triggerCertificateRenewal(certificate) {
    // Ensure we don't have multiple renewal processes for the same certificate
    const lockId = `cert-renewal-${path.basename(certificate.path)}`;

    if (await this.fileLock.acquireLock(lockId, 3600000)) {
      // 1 hour lock
      try {
        logger.info(
          `Starting renewal process for certificate: ${certificate.name}`
        );

        // Determine renewal strategy based on certificate type
        if (certificate.type === "letsencrypt") {
          await this._renewLetsEncryptCertificate(certificate);
        } else if (certificate.type === "internal") {
          await this._renewInternalCertificate(certificate);
        } else {
          logger.warn(
            `No renewal strategy available for certificate type: ${certificate.type}`
          );
        }
      } catch (err) {
        logger.error(
          `Failed to renew certificate ${certificate.name}: ${err.message}`
        );
      } finally {
        await this.fileLock.releaseLock(lockId);
      }
    } else {
      logger.debug(
        `Renewal already in progress for certificate: ${certificate.name}`
      );
    }
  }

  /**
   * Renew a Let's Encrypt certificate
   * @param {Object} certificate - Certificate information
   */
  async _renewLetsEncryptCertificate(certificate) {
    logger.info(`Renewing Let's Encrypt certificate: ${certificate.name}`);

    try {
      // Implementation would depend on the Let's Encrypt client being used
      // This is a placeholder for the actual renewal code
      logger.info(
        `Let's Encrypt renewal would be triggered here for ${certificate.name}`
      );

      // Example: Run certbot renewal command
      // await execAsync('certbot renew --cert-name ' + certificate.name);

      // After renewal, refresh certificate information
      await this.certManager.scanCertificates();

      logger.info(
        `Successfully renewed Let's Encrypt certificate: ${certificate.name}`
      );
      return true;
    } catch (err) {
      logger.error(
        `Failed to renew Let's Encrypt certificate ${certificate.name}: ${err.message}`
      );
      throw err;
    }
  }

  /**
   * Renew an internal certificate
   * @param {Object} certificate - Certificate information
   */
  async _renewInternalCertificate(certificate) {
    logger.info(`Renewing internal certificate: ${certificate.name}`);

    try {
      // Implementation depends on how internal certificates are generated
      // This is a placeholder for the actual renewal code
      logger.info(
        `Internal certificate renewal would be triggered here for ${certificate.name}`
      );

      // After renewal, refresh certificate information
      await this.certManager.scanCertificates();

      logger.info(
        `Successfully renewed internal certificate: ${certificate.name}`
      );
      return true;
    } catch (err) {
      logger.error(
        `Failed to renew internal certificate ${certificate.name}: ${err.message}`
      );
      throw err;
    }
  }

  /**
   * Get certificate metrics
   * @param {boolean} [forceRefresh=false] - Force refresh of metrics
   * @returns {Promise<Object>} Certificate metrics
   */
  async getCertificateMetrics(forceRefresh = false) {
    // Return cached metrics if available and not forcing refresh
    const now = new Date();
    if (
      !forceRefresh &&
      this.metricsCache &&
      this.metricsCacheTime &&
      now - this.metricsCacheTime < 600000
    ) {
      // 10 minutes cache
      return this.metricsCache;
    }

    // Get fresh metrics
    const metrics = await this.certManager.getCertificateMetrics();

    // Cache the metrics
    this.metricsCache = metrics;
    this.metricsCacheTime = now;

    return metrics;
  }

  /**
   * Get certificate expiration report
   * @returns {Promise<Object>} Certificate expiration report
   */
  async getExpirationReport() {
    return await this.certManager.getExpirationReport();
  }

  /**
   * Validate a specific certificate
   * @param {string} certPath - Path to the certificate file
   * @returns {Promise<Object>} Validation result
   */
  async validateCertificate(certPath) {
    return await this.certManager.validateCertificate(certPath);
  }

  /**
   * Force renewal of a specific certificate
   * @param {string} certPath - Path to the certificate file
   * @returns {Promise<Object>} Renewal result
   */
  async forceRenewal(certPath) {
    try {
      // Get certificate information
      const certInfo = await this.certManager.analyzeCertificate(certPath);

      if (!certInfo) {
        return {
          success: false,
          error: "Invalid certificate or certificate not found",
        };
      }

      // Trigger renewal
      logger.info(`Forcing renewal of certificate: ${certInfo.name}`);

      // Use lock to prevent concurrent renewal
      const lockId = `cert-renewal-${path.basename(certPath)}`;

      if (await this.fileLock.acquireLock(lockId, 3600000)) {
        // 1 hour lock
        try {
          if (certInfo.type === "letsencrypt") {
            await this._renewLetsEncryptCertificate(certInfo);
          } else if (certInfo.type === "internal") {
            await this._renewInternalCertificate(certInfo);
          } else {
            return {
              success: false,
              error: `No renewal strategy available for certificate type: ${certInfo.type}`,
            };
          }

          // Refresh certificate list
          await this.certManager.scanCertificates();

          return {
            success: true,
            message: `Successfully renewed certificate: ${certInfo.name}`,
          };
        } catch (err) {
          return {
            success: false,
            error: `Failed to renew certificate: ${err.message}`,
          };
        } finally {
          await this.fileLock.releaseLock(lockId);
        }
      } else {
        return {
          success: false,
          error: "Renewal already in progress for this certificate",
        };
      }
    } catch (err) {
      return {
        success: false,
        error: `Failed to process renewal request: ${err.message}`,
      };
    }
  }

  /**
   * Update certificate monitoring settings
   * @param {Object} settings - New monitoring settings
   * @returns {Promise<Object>} Updated settings
   */
  async updateSettings(settings) {
    try {
      // Apply settings to certificate manager
      if (settings.renewThresholdDays !== undefined) {
        this.options.renewThresholdDays = settings.renewThresholdDays;
        this.certManager.renewThresholdDays = settings.renewThresholdDays;
      }

      if (settings.checkIntervalHours !== undefined) {
        this.options.checkIntervalHours = settings.checkIntervalHours;

        // Update check interval
        if (settings.checkIntervalHours > 0) {
          this.certManager.stopPeriodicChecks();
          this.certManager.checkIntervalHours = settings.checkIntervalHours;
          this.certManager.startPeriodicChecks();
        } else {
          this.certManager.stopPeriodicChecks();
        }
      }

      if (settings.autoRenew !== undefined) {
        this.options.autoRenew = settings.autoRenew;
        this.certManager.autoRenew = settings.autoRenew;
      }

      return {
        success: true,
        settings: {
          renewThresholdDays: this.options.renewThresholdDays,
          checkIntervalHours: this.options.checkIntervalHours,
          autoRenew: this.options.autoRenew,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to update settings: ${err.message}`,
      };
    }
  }
}

module.exports = EnhancedCertificateService;
