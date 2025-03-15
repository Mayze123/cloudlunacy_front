/**
 * Certificate Service
 *
 * Handles certificate generation, storage, and distribution for MongoDB TLS
 */

const fs = require("fs").promises;
const path = require("path");
const { execSync } = require("child_process");
const logger = require("../../utils/logger").getLogger("certificateService");
const { promisify } = require("util");
const execAsync = promisify(execSync);

// Path configurations
const CERT_BASE_DIR =
  process.env.CERT_BASE_DIR || "/opt/cloudlunacy_front/certs";
const CA_KEY_PATH = path.join(CERT_BASE_DIR, "ca.key");
const CA_CERT_PATH = path.join(CERT_BASE_DIR, "ca.crt");
const MONGO_DOMAIN = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";

class CertificateService {
  constructor(configManager) {
    this.configManager = configManager;
    this.initialized = false;
    this.certsDir = process.env.CERTS_DIR || "/app/config/certs";
    this.caCertPath = path.join(this.certsDir, "ca.crt");
    this.caKeyPath = path.join(this.certsDir, "ca.key");
  }

  /**
   * Initialize the certificate service
   */
  async initialize() {
    logger.info("Initializing certificate service");

    try {
      // Ensure certificates directory exists
      await this._ensureCertsDir();

      // Ensure CA certificate exists
      await this._ensureCA();

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
   * Check if CA certificate exists
   */
  async checkCAExists() {
    try {
      await fs.access(this.caCertPath);
      await fs.access(this.caKeyPath);
      logger.info("CA certificate and key found");
      return true;
    } catch (err) {
      logger.info("CA certificate or key not found, will generate new ones");
      return false;
    }
  }

  /**
   * Generate CA certificate
   */
  async generateCA() {
    try {
      logger.info("Generating new CA certificate and key");

      // Generate CA private key
      execSync(`openssl genrsa -out ${this.caKeyPath} 2048`);

      // Generate CA certificate
      execSync(
        `openssl req -x509 -new -nodes -key ${this.caKeyPath} -sha256 -days 3650 -out ${this.caCertPath} -subj "/CN=CloudLunacy MongoDB CA/O=CloudLunacy/C=UK"`
      );

      // Set proper permissions
      await fs.chmod(this.caKeyPath, 0o600);
      await fs.chmod(this.caCertPath, 0o644);

      logger.info("CA certificate and key generated successfully");
      return true;
    } catch (err) {
      logger.error(`Failed to generate CA: ${err.message}`);
      throw err;
    }
  }

  /**
   * Generate agent certificate
   * @param {string} agentId - The agent ID
   */
  async generateAgentCertificate(agentId) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info(`Generating certificate for agent ${agentId}`);

      const certDir = path.join(this.certsDir, "agents", agentId);
      await fs.mkdir(certDir, { recursive: true });

      const serverKeyPath = path.join(certDir, "server.key");
      const serverCsrPath = path.join(certDir, "server.csr");
      const serverCertPath = path.join(certDir, "server.crt");
      const configPath = path.join(certDir, "openssl.cnf");

      // Create OpenSSL config with proper SAN
      const domain = `${agentId}.mongodb.cloudlunacy.uk`;
      await fs.writeFile(
        configPath,
        `
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = ${domain}

[v3_req]
subjectAltName = @alt_names

[alt_names]
DNS.1 = ${domain}
DNS.2 = *.${domain}
DNS.3 = localhost
IP.1 = 127.0.0.1
      `
      );

      // Generate server key
      execSync(`openssl genrsa -out ${serverKeyPath} 2048`);

      // Generate CSR with config
      execSync(
        `openssl req -new -key ${serverKeyPath} -out ${serverCsrPath} -config ${configPath}`
      );

      // Sign the certificate with our CA
      execSync(
        `openssl x509 -req -in ${serverCsrPath} -CA ${this.caCertPath} -CAkey ${this.caKeyPath} -CAcreateserial -out ${serverCertPath} -days 825 -extensions v3_req -extfile ${configPath}`
      );

      // Set proper permissions
      await fs.chmod(serverKeyPath, 0o600);
      await fs.chmod(serverCertPath, 0o644);

      // Read the generated files
      const caCert = await fs.readFile(this.caCertPath, "utf8");
      const serverKey = await fs.readFile(serverKeyPath, "utf8");
      const serverCert = await fs.readFile(serverCertPath, "utf8");

      logger.info(`Certificate for agent ${agentId} generated successfully`);

      return {
        success: true,
        caCert,
        serverKey,
        serverCert,
      };
    } catch (err) {
      logger.error(
        `Failed to generate certificate for agent ${agentId}: ${err.message}`
      );
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Get CA certificate
   */
  async getCA() {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      const caCert = await fs.readFile(this.caCertPath, "utf8");
      return {
        success: true,
        caCert,
      };
    } catch (err) {
      logger.error(`Failed to get CA certificate: ${err.message}`);
      return {
        success: false,
        error: err.message,
      };
    }
  }

  async _ensureCertsDir() {
    // Implementation of _ensureCertsDir method
  }

  async _ensureCA() {
    // Implementation of _ensureCA method
  }
}

module.exports = CertificateService;
