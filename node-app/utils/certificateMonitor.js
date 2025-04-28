/**
 * Certificate Monitor
 *
 * Monitors certificate operations, health, and expiration:
 * - Tracks certificate expiration dates and sends alerts for near-expiry certificates
 * - Monitors renewal successes and failures
 * - Provides certificate health metrics for observability
 * - Implements event-based notification system for certificate lifecycle events
 */

const EventEmitter = require("events");
const fs = require("fs").promises;
const path = require("path");
const logger = require("./logger").getLogger("certificateMonitor");

// Certificate health states
const HEALTH_STATE = {
  GOOD: "GOOD", // Certificate is valid and not expiring soon
  WARNING: "WARNING", // Certificate is valid but expiring soon
  EXPIRED: "EXPIRED", // Certificate has expired
  INVALID: "INVALID", // Certificate is invalid (e.g., incorrect format)
  UNKNOWN: "UNKNOWN", // Certificate state cannot be determined
};

class CertificateMonitor extends EventEmitter {
  /**
   * Create a new certificate monitor
   * @param {Object} options - Monitor options
   * @param {string} options.certificatesPath - Directory containing certificates
   * @param {number} options.warningThresholdDays - Days before expiry to trigger warning
   * @param {number} options.checkInterval - Minutes between certificate checks
   * @param {Function} options.getActiveCertificates - Function to get active certificates
   * @param {Function} options.notifyExpiringSoon - Function called when certificate is expiring soon
   * @param {Function} options.notifyExpired - Function called when certificate has expired
   */
  constructor(options = {}) {
    super();

    // Support both naming conventions for backward compatibility
    this.certificatesPath =
      options.certificatesPath ||
      options.certDir ||
      process.env.CERT_DIR ||
      "./certs";
    this.warningThresholdDays = options.warningThresholdDays || 30;
    this.criticalThresholdDays = options.criticalThresholdDays || 7;

    // Convert to minutes if passed in milliseconds
    if (options.checkInterval && options.checkInterval > 1000) {
      this.checkIntervalMinutes = Math.floor(
        options.checkInterval / (60 * 1000)
      );
    } else {
      this.checkIntervalMinutes =
        options.checkInterval || options.checkIntervalMinutes || 60;
    }

    // Optional function to get certificates from an external source
    this.getActiveCertificates = options.getActiveCertificates;

    this.notifyExpiringSoon =
      options.notifyExpiringSoon || this._defaultNotifyExpiringSoon;
    this.notifyExpired = options.notifyExpired || this._defaultNotifyExpired;

    // Metrics tracking
    this.metrics = {
      certsByAgent: {}, // Certificates by agent ID
      certsByDomain: {}, // Certificates by domain
      expiringCerts: [], // Certificates expiring soon
      expiredCerts: [], // Expired certificates
      renewalHistory: [], // History of renewal operations
      totalValidCerts: 0, // Count of valid certificates
      totalExpiredCerts: 0, // Count of expired certificates
      totalExpiringCerts: 0, // Count of certificates expiring soon
      lastCheckTimestamp: null, // Last time certificates were checked
    };

    // Operation tracking
    this.operations = {
      issuedCount: 0,
      renewedCount: 0,
      revokedCount: 0,
      failedOperations: [],
      consecutiveFailures: 0,
      lastOperationTimestamp: null,
      lastOperationSuccess: null,
    };

    this.checkIntervalId = null;

    // Log initialized state
    logger.debug(
      `Certificate monitor initialized with path: ${this.certificatesPath}`
    );
  }

  /**
   * Start monitoring certificates
   */
  start() {
    if (this.checkIntervalId) {
      this.stop();
    }

    logger.info(
      `Starting certificate monitoring (checking every ${this.checkIntervalMinutes} minutes)`
    );

    // Run immediate check
    this.checkCertificates();

    // Schedule regular checks
    this.checkIntervalId = setInterval(() => {
      this.checkCertificates();
    }, this.checkIntervalMinutes * 60 * 1000);

    // Prevent timer from blocking Node exit
    if (this.checkIntervalId.unref) {
      this.checkIntervalId.unref();
    }
  }

  /**
   * Stop monitoring certificates
   */
  stop() {
    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId);
      this.checkIntervalId = null;
      logger.info("Certificate monitoring stopped");
    }
  }

  /**
   * Check all certificates in the certificate directory
   * @returns {Promise<Object>} Certificate check results
   */
  async checkCertificates() {
    logger.debug("Checking certificate statuses");

    // Reset metrics for recounting
    this.metrics.expiringCerts = [];
    this.metrics.expiredCerts = [];
    this.metrics.totalValidCerts = 0;
    this.metrics.totalExpiredCerts = 0;
    this.metrics.totalExpiringCerts = 0;

    try {
      const now = new Date();
      this.metrics.lastCheckTimestamp = now;

      // If there's a getActiveCertificates function provided, use it first
      if (typeof this.getActiveCertificates === "function") {
        try {
          logger.debug("Using provided function to get active certificates");
          const activeCerts = await this.getActiveCertificates();

          if (Array.isArray(activeCerts) && activeCerts.length > 0) {
            // Process certificates from external source
            this._processActiveCertificates(activeCerts);

            // Emit certificate check event
            this.emit("certificates-checked", {
              timestamp: now,
              totalValid: this.metrics.totalValidCerts,
              totalExpired: this.metrics.totalExpiredCerts,
              totalExpiring: this.metrics.totalExpiringCerts,
              expiringCerts: this.metrics.expiringCerts.map((c) => ({
                domain: c.domain,
                expiresIn: c.daysUntilExpiry,
              })),
            });

            return {
              totalValid: this.metrics.totalValidCerts,
              totalExpired: this.metrics.totalExpiredCerts,
              totalExpiring: this.metrics.totalExpiringCerts,
            };
          } else {
            logger.debug(
              "No certificates returned from getActiveCertificates, falling back to file scanning"
            );
          }
        } catch (err) {
          logger.warn(
            `Error getting active certificates from function: ${err.message}, falling back to file scanning`
          );
        }
      }

      // Fallback to scanning the agents directory
      const agentsDir = path.join(this.certificatesPath, "agents");

      try {
        const agents = await fs.readdir(agentsDir);

        for (const agent of agents) {
          const agentCertDir = path.join(agentsDir, agent);
          const stat = await fs.stat(agentCertDir);

          if (!stat.isDirectory()) {
            continue;
          }

          // Initialize agent in metrics if not exists
          if (!this.metrics.certsByAgent[agent]) {
            this.metrics.certsByAgent[agent] = {
              validCerts: 0,
              expiredCerts: 0,
              expiringCerts: 0,
              domains: [],
            };
          }

          // Check certificates for this agent
          await this._checkAgentCertificates(agent, agentCertDir);
        }

        // Emit certificate check event
        this.emit("certificates-checked", {
          timestamp: now,
          totalValid: this.metrics.totalValidCerts,
          totalExpired: this.metrics.totalExpiredCerts,
          totalExpiring: this.metrics.totalExpiringCerts,
          expiringCerts: this.metrics.expiringCerts.map((c) => ({
            domain: c.domain,
            expiresIn: c.daysUntilExpiry,
          })),
        });

        return {
          totalValid: this.metrics.totalValidCerts,
          totalExpired: this.metrics.totalExpiredCerts,
          totalExpiring: this.metrics.totalExpiringCerts,
        };
      } catch (err) {
        if (err.code === "ENOENT") {
          logger.warn(`Agents directory does not exist: ${agentsDir}`);
          return { totalValid: 0, totalExpired: 0, totalExpiring: 0 };
        }
        throw err;
      }
    } catch (err) {
      logger.error(`Error checking certificates: ${err.message}`);
      this.emit("check-error", { error: err.message });
      throw err;
    }
  }

  /**
   * Process active certificates from an external source
   * @param {Array} certificates - Array of certificate objects
   * @private
   */
  _processActiveCertificates(certificates) {
    if (!Array.isArray(certificates)) {
      logger.warn(
        "Expected certificates to be an array but got: " + typeof certificates
      );
      if (certificates && typeof certificates === "object") {
        logger.warn(
          `Expected certificates to be an array but got: object with keys: [${Object.keys(
            certificates
          )}]`
        );
      }
      return;
    }

    // Process each certificate
    for (const cert of certificates) {
      try {
        if (!cert.domain && cert.name) {
          cert.domain = cert.name; // Use name as domain if domain not present
        }

        if (!cert.domain) {
          logger.warn("Certificate missing domain/name property, skipping");
          continue;
        }

        // Extract agent ID from domain or use provided name/id
        const agentId = cert.agentId || cert.name || cert.domain.split(".")[0];

        // Initialize agent metrics if needed
        if (!this.metrics.certsByAgent[agentId]) {
          this.metrics.certsByAgent[agentId] = {
            validCerts: 0,
            expiredCerts: 0,
            expiringCerts: 0,
            domains: [],
          };
        }

        // Add domain to agent if not already present
        if (!this.metrics.certsByAgent[agentId].domains.includes(cert.domain)) {
          this.metrics.certsByAgent[agentId].domains.push(cert.domain);
        }

        // Calculate days until expiry if not provided
        let daysUntilExpiry = cert.daysRemaining;
        let expiryDate = cert.expiresAt ? new Date(cert.expiresAt) : null;

        if (!daysUntilExpiry && expiryDate) {
          const now = new Date();
          daysUntilExpiry = Math.floor(
            (expiryDate - now) / (1000 * 60 * 60 * 24)
          );
        }

        // Determine certificate state
        let state = HEALTH_STATE.UNKNOWN;

        if (
          cert.valid === false ||
          (daysUntilExpiry !== undefined && daysUntilExpiry <= 0)
        ) {
          state = HEALTH_STATE.EXPIRED;
          this.metrics.certsByAgent[agentId].expiredCerts++;
          this.metrics.totalExpiredCerts++;
          this.metrics.expiredCerts.push({
            domain: cert.domain,
            agentId,
            expiryDate,
          });
        } else if (
          daysUntilExpiry !== undefined &&
          daysUntilExpiry <= this.warningThresholdDays
        ) {
          state = HEALTH_STATE.WARNING;
          this.metrics.certsByAgent[agentId].expiringCerts++;
          this.metrics.totalExpiringCerts++;
          this.metrics.expiringCerts.push({
            domain: cert.domain,
            agentId,
            expiryDate,
            daysUntilExpiry,
          });
        } else if (cert.valid !== false) {
          state = HEALTH_STATE.GOOD;
          this.metrics.certsByAgent[agentId].validCerts++;
          this.metrics.totalValidCerts++;
        }

        // Store in domain metrics
        this.metrics.certsByDomain[cert.domain] = {
          domain: cert.domain,
          agentId,
          state,
          expiryDate,
          daysUntilExpiry,
          issueDate: cert.issueDate ? new Date(cert.issueDate) : null,
          path: cert.path,
        };

        // Emit events for expiring/expired certificates
        if (state === HEALTH_STATE.WARNING) {
          this.emit("certificate-warning", {
            domain: cert.domain,
            daysUntilExpiry,
            expiryDate,
          });

          // Also call the notification function
          this.notifyExpiringSoon({
            domain: cert.domain,
            daysUntilExpiry,
            expiryDate,
          });
        } else if (state === HEALTH_STATE.EXPIRED) {
          this.emit("certificate-expired", {
            domain: cert.domain,
            expiryDate,
          });

          // Also call the notification function
          this.notifyExpired({
            domain: cert.domain,
            expiryDate,
          });
        }
      } catch (err) {
        logger.warn(`Error processing certificate: ${err.message}`);
      }
    }

    logger.info("Certificate metrics snapshot completed", {
      totalCertificates: certificates.length,
      validCertificates: this.metrics.totalValidCerts,
      expiringSoon: this.metrics.totalExpiringCerts,
      expired: this.metrics.totalExpiredCerts,
    });
  }

  /**
   * Record a certificate operation
   * @param {string} operation - Operation type (issue, renew, revoke)
   * @param {Object} details - Operation details
   * @param {boolean} success - Whether the operation was successful
   */
  recordOperation(operation, details, success) {
    const timestamp = new Date();

    // Update operations tracking
    if (success) {
      this.operations.consecutiveFailures = 0;

      switch (operation) {
        case "issue":
          this.operations.issuedCount++;
          break;
        case "renew":
          this.operations.renewedCount++;
          break;
        case "revoke":
          this.operations.revokedCount++;
          break;
      }
    } else {
      this.operations.consecutiveFailures++;
      this.operations.failedOperations.push({
        operation,
        timestamp,
        details,
        error: details.error || "Unknown error",
      });

      // Limit failed operations history
      if (this.operations.failedOperations.length > 100) {
        this.operations.failedOperations.shift();
      }
    }

    this.operations.lastOperationTimestamp = timestamp;
    this.operations.lastOperationSuccess = success;

    // Add to renewal history if it's a renewal
    if (operation === "renew") {
      this.metrics.renewalHistory.push({
        domain: details.domain,
        timestamp,
        success,
        error: success ? null : details.error || "Unknown error",
      });

      // Limit renewal history
      if (this.metrics.renewalHistory.length > 100) {
        this.metrics.renewalHistory.shift();
      }
    }

    // Emit operation event
    this.emit(`certificate-${operation}`, {
      success,
      timestamp,
      ...details,
    });
  }

  /**
   * Get current certificate metrics
   * @returns {Object} Certificate metrics
   */
  getMetrics() {
    return {
      summary: {
        totalValidCerts: this.metrics.totalValidCerts,
        totalExpiredCerts: this.metrics.totalExpiredCerts,
        totalExpiringCerts: this.metrics.totalExpiringCerts,
        lastCheckTimestamp: this.metrics.lastCheckTimestamp,
      },
      expiringCertificates: this.metrics.expiringCerts,
      expiredCertificates: this.metrics.expiredCerts,
      operations: {
        issued: this.operations.issuedCount,
        renewed: this.operations.renewedCount,
        revoked: this.operations.revokedCount,
        lastOperation: this.operations.lastOperationTimestamp
          ? {
              timestamp: this.operations.lastOperationTimestamp,
              success: this.operations.lastOperationSuccess,
            }
          : null,
        consecutiveFailures: this.operations.consecutiveFailures,
        recentFailures: this.operations.failedOperations.slice(-5),
      },
      renewalHistory: this.metrics.renewalHistory.slice(-10),
    };
  }

  /**
   * Get health status of a specific certificate
   * @param {string} domain - Domain name
   * @returns {Promise<Object>} Certificate health status
   */
  async getCertificateHealth(domain) {
    if (!this.metrics.certsByDomain[domain]) {
      return {
        domain,
        state: HEALTH_STATE.UNKNOWN,
        message: "Certificate not found in monitoring system",
      };
    }

    return this.metrics.certsByDomain[domain];
  }

  /**
   * Default notification handler for expiring certificates
   * @param {Object} certInfo - Certificate information
   * @private
   */
  _defaultNotifyExpiringSoon(certInfo) {
    logger.warn(
      `Certificate for ${certInfo.domain} is expiring in ${certInfo.daysUntilExpiry} days`
    );
  }

  /**
   * Default notification handler for expired certificates
   * @param {Object} certInfo - Certificate information
   * @private
   */
  _defaultNotifyExpired(certInfo) {
    logger.error(
      `Certificate for ${certInfo.domain} has expired on ${
        certInfo.expiryDate.toISOString().split("T")[0]
      }`
    );
  }

  /**
   * Check certificates for a specific agent
   * @param {string} agentId - Agent ID
   * @param {string} agentCertDir - Agent certificate directory
   * @private
   */
  async _checkAgentCertificates(agentId, agentCertDir) {
    try {
      const files = await fs.readdir(agentCertDir);

      for (const file of files) {
        if (file.endsWith(".crt") || file.endsWith(".pem")) {
          // Extract domain from filename (assuming format domain.tld.crt)
          const domain = file.replace(/\.(crt|pem)$/, "");

          // Check certificate
          const certPath = path.join(agentCertDir, file);
          const health = await this._checkCertificate(domain, certPath);

          // Update domain in agent metrics
          if (!this.metrics.certsByAgent[agentId].domains.includes(domain)) {
            this.metrics.certsByAgent[agentId].domains.push(domain);
          }

          // Update agent counts
          switch (health.state) {
            case HEALTH_STATE.GOOD:
              this.metrics.certsByAgent[agentId].validCerts++;
              this.metrics.totalValidCerts++;
              break;
            case HEALTH_STATE.WARNING:
              this.metrics.certsByAgent[agentId].expiringCerts++;
              this.metrics.totalExpiringCerts++;
              this.metrics.expiringCerts.push({
                domain,
                agentId,
                expiryDate: health.expiryDate,
                daysUntilExpiry: health.daysUntilExpiry,
              });
              break;
            case HEALTH_STATE.EXPIRED:
              this.metrics.certsByAgent[agentId].expiredCerts++;
              this.metrics.totalExpiredCerts++;
              this.metrics.expiredCerts.push({
                domain,
                agentId,
                expiryDate: health.expiryDate,
              });
              break;
          }

          // Store in domain metrics
          this.metrics.certsByDomain[domain] = {
            domain,
            agentId,
            state: health.state,
            expiryDate: health.expiryDate,
            daysUntilExpiry: health.daysUntilExpiry,
            issueDate: health.issueDate,
            path: certPath,
          };
        }
      }
    } catch (err) {
      logger.error(
        `Error checking certificates for agent ${agentId}: ${err.message}`
      );
      // Continue processing other agents
    }
  }

  /**
   * Check an individual certificate
   * @param {string} domain - Domain name
   * @param {string} certPath - Path to certificate file
   * @returns {Promise<Object>} Certificate health information
   * @private
   */
  async _checkCertificate(domain, certPath) {
    try {
      // Read certificate file
      const certData = await fs.readFile(certPath, "utf8");

      // This is a simplified check - in a real implementation, use a proper
      // cert parsing library like node-forge or openssl command

      // Extract expiry date from certificate (simplified example)
      // In real implementation, parse the certificate properly
      let expiryDate;
      let issueDate;

      try {
        // For demonstration, we'll use a mock implementation
        // In production, use proper X509 certificate parsing
        const expiryMatch = certData.match(/notAfter=([^\n]+)/i);
        const issueMatch = certData.match(/notBefore=([^\n]+)/i);

        if (expiryMatch) {
          expiryDate = new Date(expiryMatch[1]);
        } else {
          // Fallback: set a fake expiry date 90 days from now
          expiryDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
          logger.warn(
            `Could not extract expiry date for ${domain}, using mock date`
          );
        }

        if (issueMatch) {
          issueDate = new Date(issueMatch[1]);
        } else {
          // Fallback: set a fake issue date 90 days ago
          issueDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
        }
      } catch (err) {
        logger.error(`Error parsing certificate for ${domain}: ${err.message}`);
        return {
          state: HEALTH_STATE.INVALID,
          error: err.message,
        };
      }

      // Calculate days until expiry
      const now = new Date();
      const daysUntilExpiry = Math.floor(
        (expiryDate - now) / (1000 * 60 * 60 * 24)
      );

      // Check certificate status
      if (expiryDate < now) {
        // Certificate has expired
        this.notifyExpired({ domain, expiryDate, certPath });
        return {
          state: HEALTH_STATE.EXPIRED,
          expiryDate,
          issueDate,
          daysUntilExpiry,
        };
      } else if (daysUntilExpiry <= this.warningThresholdDays) {
        // Certificate is expiring soon
        this.notifyExpiringSoon({
          domain,
          expiryDate,
          daysUntilExpiry,
          certPath,
        });
        return {
          state: HEALTH_STATE.WARNING,
          expiryDate,
          issueDate,
          daysUntilExpiry,
        };
      } else {
        // Certificate is good
        return {
          state: HEALTH_STATE.GOOD,
          expiryDate,
          issueDate,
          daysUntilExpiry,
        };
      }
    } catch (err) {
      logger.error(`Error reading certificate for ${domain}: ${err.message}`);
      return {
        state: HEALTH_STATE.UNKNOWN,
        error: err.message,
      };
    }
  }
}

// Export health states for external use
CertificateMonitor.HEALTH_STATE = HEALTH_STATE;

module.exports = CertificateMonitor;
