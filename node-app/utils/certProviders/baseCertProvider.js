/**
 * Base Certificate Provider
 *
 * Abstract base class that defines the interface all certificate providers must implement.
 * Certificate providers are responsible for issuing, renewing, and managing certificates
 * from different sources (self-signed, ACME/Let's Encrypt, etc.)
 */

const fs = require("fs").promises;
const path = require("path");
const logger = require("../logger").getLogger("baseCertProvider");
const { AppError } = require("../errorHandler");

class BaseCertProvider {
  /**
   * Create a new certificate provider
   * @param {Object} config - Configuration options
   */
  constructor(config = {}) {
    if (this.constructor === BaseCertProvider) {
      throw new Error(
        "BaseCertProvider is an abstract class and cannot be instantiated directly"
      );
    }

    this.config = config;
    this.certsDir =
      config.certsDir || path.join(process.cwd(), "config", "certs");
    this.keySize = config.keySize || 2048;
    this.validityDays = config.validityDays || 365;
    this.initialized = false;
  }

  /**
   * Initialize the provider
   * Sets up any necessary directories or resources
   * @returns {Promise<boolean>} True if initialization was successful
   */
  async initialize() {
    try {
      // Ensure certificates directory exists
      await fs.mkdir(this.certsDir, { recursive: true });
      this.initialized = true;
      return true;
    } catch (err) {
      logger.error(`Provider initialization failed: ${err.message}`);
      throw new AppError(`Provider initialization failed: ${err.message}`, 500);
    }
  }

  /**
   * Get provider information
   * @returns {Object} Information about this provider's capabilities
   */
  getProviderInfo() {
    throw new Error("getProviderInfo() must be implemented by subclass");
  }

  /**
   * Validate the provider configuration
   * @returns {Object} Validation results with issues array
   */
  async validateConfiguration() {
    throw new Error("validateConfiguration() must be implemented by subclass");
  }

  /**
   * Generate a certificate for a domain
   * @param {string} domain - Domain to generate certificate for
   * @param {Object} options - Certificate options
   * @returns {Promise<Object>} Certificate generation result
   */
  async generateCertificate(domain, options = {}) {
    throw new Error("generateCertificate() must be implemented by subclass");
  }

  /**
   * Renew an existing certificate
   * @param {string} domain - Domain to renew certificate for
   * @param {Object} options - Certificate renewal options
   * @returns {Promise<Object>} Certificate renewal result
   */
  async renewCertificate(domain, options = {}) {
    throw new Error("renewCertificate() must be implemented by subclass");
  }

  /**
   * Revoke an existing certificate
   * @param {string} domain - Domain to revoke certificate for
   * @param {string} reason - Reason for revocation
   * @returns {Promise<Object>} Certificate revocation result
   */
  async revokeCertificate(domain, reason = "") {
    throw new Error("revokeCertificate() must be implemented by subclass");
  }

  /**
   * Check if a certificate exists for a domain
   * @param {string} domain - Domain to check
   * @returns {Promise<boolean>} True if certificate exists
   */
  async certificateExists(domain) {
    try {
      const certPath = path.join(this.certsDir, `${domain}.crt`);
      const keyPath = path.join(this.certsDir, `${domain}.key`);

      await Promise.all([
        fs.access(certPath, fs.constants.F_OK),
        fs.access(keyPath, fs.constants.F_OK),
      ]);

      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * Update the provider configuration
   * @param {Object} newConfig - New configuration options to apply
   * @returns {void}
   */
  updateConfig(newConfig = {}) {
    if (!newConfig) return;

    logger.info("Updating certificate provider configuration");

    // Update only valid configuration properties
    if (newConfig.certsDir) this.certsDir = newConfig.certsDir;
    if (newConfig.keySize) this.keySize = newConfig.keySize;
    if (newConfig.validityDays) this.validityDays = newConfig.validityDays;
    if (newConfig.caCertPath) this.caCertPath = newConfig.caCertPath;
    if (newConfig.caKeyPath) this.caKeyPath = newConfig.caKeyPath;

    // Update the main config object as well
    this.config = { ...this.config, ...newConfig };

    logger.debug(`Provider config updated. New certsDir: ${this.certsDir}`);
  }
}

module.exports = BaseCertProvider;
