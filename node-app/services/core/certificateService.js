/**
 * Certificate Service
 *
 * Manages TLS certificates for MongoDB and other services
 */

const fs = require("fs").promises;
const path = require("path");
const { execSync } = require("child_process");
const logger = require("../../utils/logger");
const configService = require("./configService");

class CertificateService {
  constructor() {
    this.initialized = false;
    this.certsDir = process.env.CERTS_DIR || "/traefik-certs";
    this.mongoCertsDir = path.join(this.certsDir, "mongodb");
    this.caCertPath = path.join(this.mongoCertsDir, "ca.crt");
    this.caKeyPath = path.join(this.mongoCertsDir, "ca.key");
  }

  /**
   * Initialize the certificate service
   */
  async initialize() {
    try {
      if (this.initialized) return true;

      logger.info("Initializing certificate service");

      // Create certificates directory if it doesn't exist
      await this.ensureDirectories();

      // Generate CA certificate if it doesn't exist
      await this.ensureMongoCA();

      this.initialized = true;
      logger.info("Certificate service initialized successfully");
      return true;
    } catch (err) {
      logger.error(`Failed to initialize certificate service: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return false;
    }
  }

  /**
   * Ensure required directories exist
   */
  async ensureDirectories() {
    try {
      await fs.mkdir(this.mongoCertsDir, { recursive: true });
      logger.debug(
        `Ensured MongoDB certificates directory exists: ${this.mongoCertsDir}`
      );
      return true;
    } catch (err) {
      logger.error(`Failed to create certificates directory: ${err.message}`);
      throw err;
    }
  }

  /**
   * Ensure MongoDB CA certificate exists
   */
  async ensureMongoCA() {
    try {
      // Check if CA certificate already exists
      try {
        await fs.access(this.caCertPath);
        await fs.access(this.caKeyPath);
        logger.debug("MongoDB CA certificate already exists");
        return true;
      } catch (err) {
        // CA certificate doesn't exist, generate it
        logger.info("Generating MongoDB CA certificate");

        // Generate CA key
        execSync(`openssl genrsa -out "${this.caKeyPath}" 4096`);

        // Generate CA certificate
        execSync(
          `openssl req -new -x509 -days 3650 -key "${this.caKeyPath}" -out "${this.caCertPath}" -subj "/CN=MongoDB CA/O=CloudLunacy/C=US"`
        );

        // Set proper permissions
        await fs.chmod(this.caKeyPath, 0o600);
        await fs.chmod(this.caCertPath, 0o644);

        logger.info("MongoDB CA certificate generated successfully");
        return true;
      }
    } catch (err) {
      logger.error(`Failed to ensure MongoDB CA certificate: ${err.message}`);
      throw err;
    }
  }

  /**
   * Generate server certificate for an agent
   * @param {string} agentId - Agent ID
   * @returns {Object} - Certificate data
   */
  async generateServerCertificate(agentId) {
    try {
      if (!this.initialized) await this.initialize();

      const certDir = path.join(this.mongoCertsDir, agentId);
      await fs.mkdir(certDir, { recursive: true });

      const keyPath = path.join(certDir, "server.key");
      const csrPath = path.join(certDir, "server.csr");
      const crtPath = path.join(certDir, "server.crt");

      // Generate server key
      execSync(`openssl genrsa -out "${keyPath}" 4096`);

      // Generate CSR with the agent's MongoDB domain as CN
      const domain = `${agentId}.${
        process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk"
      }`;
      execSync(
        `openssl req -new -key "${keyPath}" -out "${csrPath}" -subj "/CN=${domain}/O=CloudLunacy/C=US"`
      );

      // Sign the certificate with our CA
      execSync(
        `openssl x509 -req -days 3650 -in "${csrPath}" -CA "${this.caCertPath}" -CAkey "${this.caKeyPath}" -CAcreateserial -out "${crtPath}"`
      );

      // Set proper permissions
      await fs.chmod(keyPath, 0o600);
      await fs.chmod(crtPath, 0o644);

      // Read certificate files
      const [key, crt, ca] = await Promise.all([
        fs.readFile(keyPath, "utf8"),
        fs.readFile(crtPath, "utf8"),
        fs.readFile(this.caCertPath, "utf8"),
      ]);

      logger.info(`Generated server certificate for agent ${agentId}`);

      return {
        key,
        cert: crt,
        ca,
      };
    } catch (err) {
      logger.error(`Failed to generate server certificate: ${err.message}`, {
        agentId,
        error: err.message,
        stack: err.stack,
      });
      throw err;
    }
  }

  /**
   * Get CA certificate
   * @returns {Promise<string>} - CA certificate content
   */
  async getMongoCA() {
    try {
      if (!this.initialized) await this.initialize();
      return await fs.readFile(this.caCertPath, "utf8");
    } catch (err) {
      logger.error(`Failed to read CA certificate: ${err.message}`);
      throw err;
    }
  }
}

module.exports = new CertificateService();
