/**
 * Enhanced Certificate Manager
 *
 * Provides improved certificate handling with circuit breaking, monitoring,
 * and error recovery for more reliable certificate operations.
 *
 * Features:
 * - Circuit breaking to prevent cascading failures
 * - Monitoring for certificate health and expiration
 * - Automatic certificate renewal scheduling
 * - Rate limiting protection for API providers
 * - Expiration notifications
 */

const fs = require("fs").promises;
const path = require("path");
const { promisify } = require("util");
const exec = promisify(require("child_process").exec);
const EventEmitter = require("events");

const logger = require("./logger").getLogger("enhancedCertificateManager");
const CertificateCircuitBreaker = require("./certificateCircuitBreaker");
const CertificateMonitor = require("./certificateMonitor");
const RetryHandler = require("./retryHandler");

class EnhancedCertificateManager extends EventEmitter {
  /**
   * Create a new enhanced certificate manager
   * @param {Object} options - Configuration options
   * @param {string} options.certsPath - Path to certificates directory
   * @param {number} options.defaultRenewalDays - Days before expiry to attempt renewal
   * @param {number} options.renewalScheduleInterval - How often to check for renewals (ms)
   * @param {Object} options.circuitBreakerOptions - Options for the circuit breaker
   * @param {Object} options.monitorOptions - Options for the certificate monitor
   * @param {Object} options.retryOptions - Options for retry handling
   */
  constructor(options = {}) {
    super();

    this.certsPath =
      options.certsPath || path.join(process.cwd(), "config/certs");
    this.defaultRenewalDays = options.defaultRenewalDays || 30;
    this.renewalScheduleInterval =
      options.renewalScheduleInterval || 24 * 60 * 60 * 1000; // 24 hours default

    // Create the circuit breaker
    this.circuitBreaker = new CertificateCircuitBreaker({
      failureThreshold: options.circuitBreakerOptions?.failureThreshold || 5,
      resetTimeout:
        options.circuitBreakerOptions?.resetTimeout || 5 * 60 * 1000, // 5 minutes
      healthCheck: async () => this._checkCertificateSystemHealth(),
    });

    // Set up the retry handler
    this.retryHandler = new RetryHandler({
      retryCount: options.retryOptions?.retryCount || 3,
      initialDelay: options.retryOptions?.initialDelay || 1000,
      maxDelay: options.retryOptions?.maxDelay || 30000,
      backoffFactor: options.retryOptions?.backoffFactor || 2,
    });

    // Create the certificate monitor
    this.certificateMonitor = new CertificateMonitor({
      certificatesPath: this.certsPath,
      getActiveCertificates: () => this.getActiveCertificates(),
      checkInterval: options.monitorOptions?.checkInterval || 60 * 60 * 1000, // 1 hour
      warningThresholdDays: options.monitorOptions?.warningThresholdDays || 14,
      criticalThresholdDays: options.monitorOptions?.criticalThresholdDays || 3,
    });

    // Setup renewal scheduling
    this.renewalSchedule = [];
    this.renewalTimer = null;
    this.initialized = false;

    // Forward monitor events
    this.certificateMonitor.on("certificate-warning", (data) => {
      this.emit("certificate-warning", data);
    });

    this.certificateMonitor.on("certificate-critical", (data) => {
      this.emit("certificate-critical", data);
    });

    this.certificateMonitor.on("status-change", (data) => {
      this.emit("status-change", data);
    });
  }

  /**
   * Initialize the enhanced certificate manager
   * @returns {Promise<boolean>} Success status
   */
  async initialize() {
    try {
      logger.info("Initializing enhanced certificate manager");

      // Ensure certificate directories exist
      await this._ensureDirectories();

      // Start the certificate monitor
      await this.certificateMonitor.start();

      // Start health checks for the circuit breaker
      this.circuitBreaker.startHealthChecks();

      // Schedule certificate renewals
      await this._scheduleRenewals();

      this.initialized = true;
      logger.info("Enhanced certificate manager initialized successfully");
      return true;
    } catch (err) {
      logger.error(
        `Failed to initialize enhanced certificate manager: ${err.message}`
      );
      return false;
    }
  }

  /**
   * Shutdown the certificate manager
   */
  shutdown() {
    logger.info("Shutting down enhanced certificate manager");

    // Stop renewal timer
    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer);
      this.renewalTimer = null;
    }

    // Stop certificate monitor
    this.certificateMonitor.stop();

    // Stop circuit breaker health checks
    this.circuitBreaker.stopHealthChecks();

    this.initialized = false;
    logger.info("Enhanced certificate manager shut down");
  }

  /**
   * Issue a new certificate with circuit breaking protection
   * @param {string} domain - Domain to issue certificate for
   * @param {Object} options - Certificate options
   * @returns {Promise<Object>} Certificate result
   */
  async issueCertificate(domain, options = {}) {
    if (!this.initialized) {
      throw new Error("Certificate manager is not initialized");
    }

    logger.info(`Issuing certificate for ${domain}`);

    try {
      // Execute certificate issuance with circuit breaker
      const result = await this.circuitBreaker.execute(
        async () => {
          // Use retry handler for the actual issuance
          return await this.retryHandler.execute(
            async () => {
              // Implement actual certificate issuance logic here
              // This would typically call your certificate service or provider

              // For now, simulate a successful issuance
              const certResult = {
                success: true,
                domain,
                expiresAt: new Date(
                  Date.now() + 90 * 24 * 60 * 60 * 1000
                ).toISOString(), // 90 days
                certPath: path.join(this.certsPath, domain, "cert.pem"),
              };

              return certResult;
            },
            `Issue certificate for ${domain}`,
            (err) => {
              // Only retry on network or server errors, not validation errors
              return !err.status || (err.status >= 500 && err.status < 600);
            }
          );
        },
        `Issue certificate for ${domain}`,
        "issue" // Operation type for rate limiting
      );

      // Record the issuance attempt in the monitor
      this.certificateMonitor.recordIssuanceAttempt({
        success: true,
        domain,
      });

      // Add to renewal schedule
      await this._addToRenewalSchedule(domain, result);

      return result;
    } catch (err) {
      // Record failed issuance
      this.certificateMonitor.recordIssuanceAttempt({
        success: false,
        domain,
        error: err.message,
      });

      logger.error(`Failed to issue certificate for ${domain}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Renew a certificate with circuit breaking protection
   * @param {string} domain - Domain to renew certificate for
   * @param {Object} options - Renewal options
   * @returns {Promise<Object>} Renewal result
   */
  async renewCertificate(domain, options = {}) {
    if (!this.initialized) {
      throw new Error("Certificate manager is not initialized");
    }

    logger.info(`Renewing certificate for ${domain}`);

    try {
      // Execute certificate renewal with circuit breaker
      const result = await this.circuitBreaker.execute(
        async () => {
          // Use retry handler for the actual renewal
          return await this.retryHandler.execute(
            async () => {
              // Implement certificate renewal logic here
              // This would typically call your certificate service or provider

              // For now, simulate a successful renewal
              const renewalResult = {
                success: true,
                domain,
                expiresAt: new Date(
                  Date.now() + 90 * 24 * 60 * 60 * 1000
                ).toISOString(), // 90 days
                certPath: path.join(this.certsPath, domain, "cert.pem"),
              };

              return renewalResult;
            },
            `Renew certificate for ${domain}`,
            (err) => {
              // Only retry on network or server errors, not validation errors
              return !err.status || (err.status >= 500 && err.status < 600);
            }
          );
        },
        `Renew certificate for ${domain}`,
        "renew" // Operation type for rate limiting
      );

      // Record the renewal attempt in the monitor
      this.certificateMonitor.recordRenewalAttempt({
        success: true,
        domain,
      });

      // Update renewal schedule
      await this._updateRenewalSchedule(domain, result);

      return result;
    } catch (err) {
      // Record failed renewal
      this.certificateMonitor.recordRenewalAttempt({
        success: false,
        domain,
        error: err.message,
      });

      logger.error(`Failed to renew certificate for ${domain}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Revoke a certificate with circuit breaking protection
   * @param {string} domain - Domain to revoke certificate for
   * @param {Object} options - Revocation options
   * @returns {Promise<Object>} Revocation result
   */
  async revokeCertificate(domain, options = {}) {
    if (!this.initialized) {
      throw new Error("Certificate manager is not initialized");
    }

    logger.info(`Revoking certificate for ${domain}`);

    try {
      // Execute certificate revocation with circuit breaker
      const result = await this.circuitBreaker.execute(
        async () => {
          // Implement certificate revocation logic here
          // This would typically call your certificate service or provider

          // For now, simulate a successful revocation
          return {
            success: true,
            domain,
          };
        },
        `Revoke certificate for ${domain}`,
        "revoke" // Operation type for rate limiting
      );

      // Remove from renewal schedule
      await this._removeFromRenewalSchedule(domain);

      return result;
    } catch (err) {
      logger.error(
        `Failed to revoke certificate for ${domain}: ${err.message}`
      );
      throw err;
    }
  }

  /**
   * Get all active certificates
   * @returns {Promise<Array>} List of active certificates
   */
  async getActiveCertificates() {
    try {
      // This would typically query your certificate database or filesystem
      // For now, simulate some example certificates

      // In a real implementation, you would scan the certificates directory
      // or query your database for active certificates

      return [
        {
          domain: "example.com",
          valid: true,
          expiresAt: new Date(
            Date.now() + 60 * 24 * 60 * 60 * 1000
          ).toISOString(), // 60 days
        },
        {
          domain: "test.example.com",
          valid: true,
          expiresAt: new Date(
            Date.now() + 10 * 24 * 60 * 60 * 1000
          ).toISOString(), // 10 days
        },
        {
          domain: "expiring.example.com",
          valid: true,
          expiresAt: new Date(
            Date.now() + 2 * 24 * 60 * 60 * 1000
          ).toISOString(), // 2 days
        },
      ];
    } catch (err) {
      logger.error(`Failed to get active certificates: ${err.message}`);
      return [];
    }
  }

  /**
   * Get certificate status
   * @returns {Promise<Object>} Certificate system status
   */
  async getStatus() {
    return {
      initialized: this.initialized,
      circuitBreaker: this.circuitBreaker.getStatus(),
      certificates: await this.certificateMonitor.getStatus(),
      renewalSchedule: [...this.renewalSchedule],
    };
  }

  /**
   * Force a refresh of certificate status
   * @returns {Promise<Object>} Updated status
   */
  async refreshStatus() {
    await this.certificateMonitor.checkCertificates();
    return this.getStatus();
  }

  /**
   * Ensure required certificate directories exist
   * @private
   */
  async _ensureDirectories() {
    const directories = [this.certsPath, path.join(this.certsPath, "private")];

    for (const dir of directories) {
      try {
        await fs.mkdir(dir, { recursive: true });
        logger.debug(`Ensured directory exists: ${dir}`);
      } catch (err) {
        logger.error(`Failed to create directory ${dir}: ${err.message}`);
        throw err;
      }
    }
  }

  /**
   * Check certificate system health
   * @returns {Promise<boolean>} Health status
   * @private
   */
  async _checkCertificateSystemHealth() {
    try {
      // Check if certificate directories are accessible
      await fs.access(this.certsPath);

      // Check if we can run basic cert operations
      // This would typically check your certificate provider API

      // For now, simulate a health check
      return true;
    } catch (err) {
      logger.error(`Certificate system health check failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Schedule certificate renewals
   * @private
   */
  async _scheduleRenewals() {
    // Clear any existing schedule
    this.renewalSchedule = [];

    // Get all active certificates
    const certificates = await this.getActiveCertificates();

    // Calculate renewal dates
    for (const cert of certificates) {
      if (cert.valid && cert.expiresAt) {
        const expiresAt = new Date(cert.expiresAt);
        const renewalDate = new Date(expiresAt);

        // Set renewal to occur defaultRenewalDays before expiry
        renewalDate.setDate(renewalDate.getDate() - this.defaultRenewalDays);

        this.renewalSchedule.push({
          domain: cert.domain,
          expiresAt: cert.expiresAt,
          renewalDate: renewalDate.toISOString(),
        });
      }
    }

    // Sort by renewal date (earliest first)
    this.renewalSchedule.sort((a, b) => {
      return new Date(a.renewalDate) - new Date(b.renewalDate);
    });

    // Schedule next check
    this._scheduleNextRenewalCheck();

    logger.info(
      `Scheduled renewals for ${this.renewalSchedule.length} certificates`
    );
  }

  /**
   * Schedule the next renewal check
   * @private
   */
  _scheduleNextRenewalCheck() {
    // Clear any existing timer
    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer);
    }

    // Schedule the next renewal check
    this.renewalTimer = setTimeout(async () => {
      await this._checkRenewals();

      // Schedule next check
      this._scheduleNextRenewalCheck();
    }, this.renewalScheduleInterval);

    // Prevent timer from blocking Node exit
    if (this.renewalTimer.unref) {
      this.renewalTimer.unref();
    }

    logger.debug(
      `Next renewal check scheduled in ${
        this.renewalScheduleInterval / 1000
      } seconds`
    );
  }

  /**
   * Check for certificates that need renewal
   * @private
   */
  async _checkRenewals() {
    try {
      logger.info("Checking for certificate renewals");

      const now = new Date();
      let renewedCount = 0;

      for (const item of this.renewalSchedule) {
        const renewalDate = new Date(item.renewalDate);

        // If renewal date is in the past or today, attempt renewal
        if (renewalDate <= now) {
          try {
            logger.info(`Certificate for ${item.domain} needs renewal`);

            // Attempt to renew
            await this.renewCertificate(item.domain);
            renewedCount++;
          } catch (err) {
            logger.error(
              `Scheduled renewal failed for ${item.domain}: ${err.message}`
            );
          }
        }
      }

      if (renewedCount > 0) {
        logger.info(`Renewed ${renewedCount} certificates`);
      } else {
        logger.debug("No certificates needed renewal");
      }

      // Update the renewal schedule
      await this._scheduleRenewals();
    } catch (err) {
      logger.error(`Error checking renewals: ${err.message}`);
    }
  }

  /**
   * Add a certificate to the renewal schedule
   * @param {string} domain - Domain name
   * @param {Object} certInfo - Certificate information
   * @private
   */
  async _addToRenewalSchedule(domain, certInfo) {
    if (!certInfo.expiresAt) {
      return;
    }

    // Calculate renewal date
    const expiresAt = new Date(certInfo.expiresAt);
    const renewalDate = new Date(expiresAt);
    renewalDate.setDate(renewalDate.getDate() - this.defaultRenewalDays);

    // Add to schedule
    this.renewalSchedule.push({
      domain,
      expiresAt: certInfo.expiresAt,
      renewalDate: renewalDate.toISOString(),
    });

    // Resort the schedule
    this.renewalSchedule.sort((a, b) => {
      return new Date(a.renewalDate) - new Date(b.renewalDate);
    });

    logger.debug(
      `Added ${domain} to renewal schedule for ${renewalDate.toISOString()}`
    );
  }

  /**
   * Update a certificate in the renewal schedule
   * @param {string} domain - Domain name
   * @param {Object} certInfo - Certificate information
   * @private
   */
  async _updateRenewalSchedule(domain, certInfo) {
    // Remove the existing entry
    await this._removeFromRenewalSchedule(domain);

    // Add new entry
    await this._addToRenewalSchedule(domain, certInfo);
  }

  /**
   * Remove a certificate from the renewal schedule
   * @param {string} domain - Domain name
   * @private
   */
  async _removeFromRenewalSchedule(domain) {
    const initialLength = this.renewalSchedule.length;

    // Filter out the domain
    this.renewalSchedule = this.renewalSchedule.filter(
      (item) => item.domain !== domain
    );

    if (this.renewalSchedule.length < initialLength) {
      logger.debug(`Removed ${domain} from renewal schedule`);
    }
  }
}

module.exports = EnhancedCertificateManager;
