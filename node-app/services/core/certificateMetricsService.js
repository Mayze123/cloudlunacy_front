/**
 * Certificate Metrics Service
 *
 * Collects and exposes certificate-related metrics:
 * - Certificate counts (total, valid, expiring, expired)
 * - Operation success/failure rates (renewal, issuance)
 * - API rate limits and quota usage
 * - Certificate expiry statistics
 */

const EventEmitter = require("events");
const logger = require("../../utils/logger").getLogger(
  "certificateMetricsService"
);

class CertificateMetricsService {
  constructor(certificateService = null, options = {}) {
    // Store reference to certificate service
    this.certificateService = certificateService;

    this.metrics = {
      certificates: {
        total: 0,
        valid: 0,
        expiringSoon: 0,
        expired: 0,
        byProvider: {},
      },
      operations: {
        issuance: {
          success: 0,
          failure: 0,
          lastSuccess: null,
          lastFailure: null,
          averageDuration: 0,
        },
        renewal: {
          success: 0,
          failure: 0,
          lastSuccess: null,
          lastFailure: null,
          averageDuration: 0,
        },
        revocation: {
          success: 0,
          failure: 0,
        },
      },
      providers: {
        letsEncrypt: {
          quotaUsed: 0,
          quotaLimit: 50,
          quotaReset: null,
        },
        acme: {
          quotaUsed: 0,
          quotaLimit: 100,
          quotaReset: null,
        },
      },
    };

    // Store timing information for duration calculation
    this.operationTimers = new Map();

    // Register with monitor if provided
    if (options.monitor) {
      this._registerMonitorEvents(options.monitor);
    }
  }

  /**
   * Register for events from the certificate monitor
   * @param {Object} monitor - Certificate monitor instance
   * @private
   */
  _registerMonitorEvents(monitor) {
    // Update metrics when monitor status changes
    monitor.on("status-change", ({ currentStatus }) => {
      logger.debug(`Certificate monitor status changed to ${currentStatus}`);
    });

    // Update metrics for certificate renewal events
    monitor.on("renewal-success", (data) => {
      this._recordOperationSuccess("renewal", data.domain);
    });

    monitor.on("renewal-failure", (data) => {
      this._recordOperationFailure("renewal", data.domain, data.error);
    });

    // Update metrics for certificate issuance events
    monitor.on("issuance-success", (data) => {
      this._recordOperationSuccess("issuance", data.domain);
    });

    monitor.on("issuance-failure", (data) => {
      this._recordOperationFailure("issuance", data.domain, data.error);
    });
  }

  /**
   * Start timing an operation
   * @param {string} operation - Operation type ('issuance', 'renewal', 'revocation')
   * @param {string} domain - Domain name
   */
  startOperationTimer(operation, domain) {
    const key = `${operation}:${domain}`;
    this.operationTimers.set(key, {
      startTime: Date.now(),
      operation,
      domain,
    });
    logger.debug(`Started timer for ${operation} operation on ${domain}`);
  }

  /**
   * End timing an operation
   * @param {string} operation - Operation type ('issuance', 'renewal', 'revocation')
   * @param {string} domain - Domain name
   * @returns {number|null} Duration in milliseconds or null if no timer found
   */
  endOperationTimer(operation, domain) {
    const key = `${operation}:${domain}`;
    const timer = this.operationTimers.get(key);

    if (!timer) {
      logger.warn(`No timer found for ${operation} operation on ${domain}`);
      return null;
    }

    const duration = Date.now() - timer.startTime;
    this.operationTimers.delete(key);

    logger.debug(`${operation} operation for ${domain} took ${duration}ms`);
    return duration;
  }

  /**
   * Record a successful operation
   * @param {string} operation - Operation type ('issuance', 'renewal', 'revocation')
   * @param {string} domain - Domain name
   * @param {Object} details - Additional details
   */
  recordOperationSuccess(operation, domain, details = {}) {
    // End timer if it exists
    const duration = this.endOperationTimer(operation, domain) || 0;

    // Update metrics
    this._recordOperationSuccess(operation, domain, duration, details);
  }

  /**
   * Record a failed operation
   * @param {string} operation - Operation type ('issuance', 'renewal', 'revocation')
   * @param {string} domain - Domain name
   * @param {string} error - Error message
   * @param {Object} details - Additional details
   */
  recordOperationFailure(operation, domain, error, details = {}) {
    // End timer if it exists
    const duration = this.endOperationTimer(operation, domain) || 0;

    // Update metrics
    this._recordOperationFailure(operation, domain, error, duration, details);
  }

  /**
   * Update certificate metrics
   * @param {Object} metrics - Certificate metrics from monitor
   */
  updateCertificateMetrics(metrics) {
    this.metrics.certificates.total = metrics.totalCertificates || 0;
    this.metrics.certificates.valid = metrics.validCertificates || 0;
    this.metrics.certificates.expiringSoon = metrics.expiringSoon || 0;
    this.metrics.certificates.expired = metrics.expired || 0;

    // Group certificates by provider if available
    if (metrics.expiringCertificates) {
      // Reset provider counts
      this.metrics.certificates.byProvider = {};

      metrics.expiringCertificates.forEach((cert) => {
        const provider = cert.provider || "unknown";

        if (!this.metrics.certificates.byProvider[provider]) {
          this.metrics.certificates.byProvider[provider] = {
            total: 0,
            expiringSoon: 0,
            expired: 0,
          };
        }

        this.metrics.certificates.byProvider[provider].total++;

        if (cert.status === "WARNING" || cert.status === "CRITICAL") {
          this.metrics.certificates.byProvider[provider].expiringSoon++;
        } else if (cert.status === "EXPIRED") {
          this.metrics.certificates.byProvider[provider].expired++;
        }
      });
    }

    logger.debug("Updated certificate metrics");
  }

  /**
   * Update rate limit metrics for a provider
   * @param {string} provider - Provider name ('letsEncrypt', 'acme')
   * @param {Object} limits - Rate limit information
   */
  updateProviderQuota(provider, limits) {
    if (this.metrics.providers[provider]) {
      this.metrics.providers[provider].quotaUsed = limits.used || 0;
      this.metrics.providers[provider].quotaLimit =
        limits.limit || this.metrics.providers[provider].quotaLimit;
      this.metrics.providers[provider].quotaReset = limits.reset || null;

      logger.debug(
        `Updated quota metrics for ${provider}: ${limits.used}/${limits.limit}`
      );
    }
  }

  /**
   * Record operation success (internal)
   * @param {string} operation - Operation type
   * @param {string} domain - Domain name
   * @param {number} duration - Operation duration in ms
   * @param {Object} details - Additional details
   * @private
   */
  _recordOperationSuccess(operation, domain, duration = 0, details = {}) {
    if (this.metrics.operations[operation]) {
      const ops = this.metrics.operations[operation];
      ops.success++;
      ops.lastSuccess = new Date().toISOString();

      // Update average duration
      if (duration > 0) {
        if (ops.averageDuration === 0) {
          ops.averageDuration = duration;
        } else {
          ops.averageDuration =
            (ops.averageDuration * (ops.success - 1) + duration) / ops.success;
        }
      }

      // Update provider quota if provider is specified
      if (details.provider && this.metrics.providers[details.provider]) {
        this.metrics.providers[details.provider].quotaUsed++;
      }

      logger.debug(
        `Recorded successful ${operation} for ${domain} (${duration}ms)`
      );
    }
  }

  /**
   * Record operation failure (internal)
   * @param {string} operation - Operation type
   * @param {string} domain - Domain name
   * @param {string} error - Error message
   * @param {number} duration - Operation duration in ms
   * @param {Object} details - Additional details
   * @private
   */
  _recordOperationFailure(
    operation,
    domain,
    error,
    duration = 0,
    details = {}
  ) {
    if (this.metrics.operations[operation]) {
      this.metrics.operations[operation].failure++;
      this.metrics.operations[operation].lastFailure = {
        timestamp: new Date().toISOString(),
        domain,
        error: error || "Unknown error",
        duration,
      };

      logger.debug(`Recorded failed ${operation} for ${domain}: ${error}`);
    }
  }

  /**
   * Get all metrics
   * @returns {Object} All metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get summary metrics
   * @returns {Object} Summary metrics
   */
  getSummaryMetrics() {
    const operations = this.metrics.operations;

    // Calculate success rates
    const issuanceTotal =
      operations.issuance.success + operations.issuance.failure;
    const renewalTotal =
      operations.renewal.success + operations.renewal.failure;

    const issuanceSuccessRate =
      issuanceTotal > 0
        ? ((operations.issuance.success / issuanceTotal) * 100).toFixed(1)
        : 100;

    const renewalSuccessRate =
      renewalTotal > 0
        ? ((operations.renewal.success / renewalTotal) * 100).toFixed(1)
        : 100;

    return {
      certificates: {
        total: this.metrics.certificates.total,
        valid: this.metrics.certificates.valid,
        expiringSoon: this.metrics.certificates.expiringSoon,
        expired: this.metrics.certificates.expired,
      },
      operations: {
        issuance: {
          success: operations.issuance.success,
          failure: operations.issuance.failure,
          successRate: `${issuanceSuccessRate}%`,
          averageDuration: `${Math.round(
            operations.issuance.averageDuration
          )}ms`,
        },
        renewal: {
          success: operations.renewal.success,
          failure: operations.renewal.failure,
          successRate: `${renewalSuccessRate}%`,
          averageDuration: `${Math.round(
            operations.renewal.averageDuration
          )}ms`,
        },
      },
      quotaStatus: Object.entries(this.metrics.providers).reduce(
        (acc, [provider, data]) => {
          acc[provider] = `${data.quotaUsed}/${data.quotaLimit}`;
          return acc;
        },
        {}
      ),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Take a snapshot of current certificate metrics
   * @returns {Promise<Object>} Snapshot of current metrics
   */
  async takeMetricsSnapshot() {
    try {
      logger.debug("Taking certificate metrics snapshot");

      // Check if certificateService is available
      if (this.certificateService) {
        // Get all certificates
        const certificates = await this.certificateService.getAllCertificates();

        // Ensure certificates is an array
        const certificatesArray = Array.isArray(certificates)
          ? certificates
          : [];
        if (!Array.isArray(certificates)) {
          // Log more details about what we received to help debugging
          const type = typeof certificates;
          let extraInfo = "";

          if (type === "object" && certificates !== null) {
            // If it's an object, log its structure to help identify the issue
            const keys = Object.keys(certificates);
            extraInfo = ` with keys: [${keys.join(", ")}]`;

            // If it has a length property or looks like it might be array-like
            if ("length" in certificates) {
              extraInfo += `, length: ${certificates.length}`;
            }
          }

          logger.warn(
            `Expected certificates to be an array but got: ${type}${extraInfo}`
          );
        }

        // Count certificates by status
        let totalCertificates = certificatesArray.length;
        let validCertificates = 0;
        let expiringSoon = 0;
        let expired = 0;

        const now = new Date();
        const thirtyDays = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds

        certificatesArray.forEach((cert) => {
          if (!cert.expiresAt) return;

          const expiryDate = new Date(cert.expiresAt);
          const timeRemaining = expiryDate - now;

          if (timeRemaining <= 0) {
            expired++;
          } else if (timeRemaining <= thirtyDays) {
            expiringSoon++;
          } else {
            validCertificates++;
          }
        });

        // Update metrics
        this.updateCertificateMetrics({
          totalCertificates,
          validCertificates,
          expiringSoon,
          expired,
          expiringCertificates: certificatesArray.map((cert) => ({
            domain: cert.domain || "unknown",
            provider: cert.provider || "unknown",
            status: this._getCertificateStatus(cert),
            expiresAt: cert.expiresAt,
          })),
        });

        logger.info("Certificate metrics snapshot completed", {
          totalCertificates,
          validCertificates,
          expiringSoon,
          expired,
        });
      } else {
        logger.warn("Certificate service not available, using empty metrics");
      }

      return this.getMetrics();
    } catch (err) {
      logger.error(
        `Error taking certificate metrics snapshot: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
        }
      );

      // Continue with default metrics instead of throwing
      return this.getMetrics();
    }
  }

  /**
   * Determine certificate status based on expiry date
   * @param {Object} cert - Certificate object
   * @returns {string} Status (OK, WARNING, CRITICAL, EXPIRED)
   * @private
   */
  _getCertificateStatus(cert) {
    if (!cert.expiresAt) return "UNKNOWN";

    const expiryDate = new Date(cert.expiresAt);
    const now = new Date();
    const timeRemaining = expiryDate - now;

    if (timeRemaining <= 0) {
      return "EXPIRED";
    } else if (timeRemaining <= 7 * 24 * 60 * 60 * 1000) {
      // 7 days
      return "CRITICAL";
    } else if (timeRemaining <= 30 * 24 * 60 * 60 * 1000) {
      // 30 days
      return "WARNING";
    } else {
      return "OK";
    }
  }

  /**
   * Reset all metrics
   */
  resetMetrics() {
    // Preserve certificate counts but reset operation metrics
    this.metrics.operations = {
      issuance: {
        success: 0,
        failure: 0,
        lastSuccess: null,
        lastFailure: null,
        averageDuration: 0,
      },
      renewal: {
        success: 0,
        failure: 0,
        lastSuccess: null,
        lastFailure: null,
        averageDuration: 0,
      },
      revocation: {
        success: 0,
        failure: 0,
      },
    };

    // Reset provider quotas
    Object.keys(this.metrics.providers).forEach((provider) => {
      this.metrics.providers[provider].quotaUsed = 0;
    });

    // Clear operation timers
    this.operationTimers.clear();

    logger.info("Reset certificate metrics");
  }
}

module.exports = CertificateMetricsService;
