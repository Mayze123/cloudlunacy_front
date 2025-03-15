/**
 * Certificate Management Service
 *
 * Handles certificate generation, storage, and distribution for MongoDB TLS
 */

const fs = require("fs").promises;
const path = require("path");
const { execSync } = require("child_process");
const logger = require("../../utils/logger").getLogger("certificateService");

// Path configurations
const CERT_BASE_DIR =
  process.env.CERT_BASE_DIR || "/opt/cloudlunacy_front/certs";
const CA_KEY_PATH = path.join(CERT_BASE_DIR, "ca.key");
const CA_CERT_PATH = path.join(CERT_BASE_DIR, "ca.crt");
const MONGO_DOMAIN = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";

class CertificateService {
  constructor() {
    this.initialized = false;
  }

  /**
   * Initialize the certificate service
   */
  async initialize() {
    try {
      // Create certificate directory if it doesn't exist
      await fs.mkdir(CERT_BASE_DIR, { recursive: true });

      // Generate CA certificate if it doesn't exist
      if (!(await this.caExists())) {
        await this.generateCA();
      }

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
  async caExists() {
    try {
      await fs.access(CA_KEY_PATH);
      await fs.access(CA_CERT_PATH);
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * Generate CA certificate
   */
  async generateCA() {
    logger.info("Generating new CA certificate");

    try {
      // Generate CA private key
      execSync(`openssl genrsa -out ${CA_KEY_PATH} 4096`);

      // Generate CA certificate
      execSync(
        `openssl req -x509 -new -nodes -key ${CA_KEY_PATH} -sha256 -days 3650 -out ${CA_CERT_PATH} -subj "/CN=CloudLunacy MongoDB CA/O=CloudLunacy/C=UK"`
      );

      // Set permissions
      await fs.chmod(CA_KEY_PATH, 0o600);
      await fs.chmod(CA_CERT_PATH, 0o644);

      logger.info("CA certificate generated successfully");
      return true;
    } catch (err) {
      logger.error(`Failed to generate CA certificate: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      throw err;
    }
  }

  /**
   * Generate agent certificate
   * @param {string} agentId - The agent ID
   */
  async generateAgentCertificate(agentId) {
    if (!this.initialized) {
      await this.initialize();
    }

    const certDir = path.join(CERT_BASE_DIR, "agents", agentId);
    const keyPath = path.join(certDir, "mongodb.key");
    const csrPath = path.join(certDir, "mongodb.csr");
    const certPath = path.join(certDir, "mongodb.crt");
    const serverFullDomain = `${agentId}.${MONGO_DOMAIN}`;

    try {
      // Create agent cert directory
      await fs.mkdir(certDir, { recursive: true });

      // Generate private key
      execSync(`openssl genrsa -out ${keyPath} 2048`);

      // Generate CSR with SAN
      const configPath = path.join(certDir, "openssl.cnf");
      await fs.writeFile(
        configPath,
        `
[req]
req_extensions = v3_req
distinguished_name = req_distinguished_name

[req_distinguished_name]

[v3_req]
subjectAltName = @alt_names

[alt_names]
DNS.1 = ${serverFullDomain}
DNS.2 = ${agentId}
DNS.3 = localhost
      `
      );

      execSync(
        `openssl req -new -key ${keyPath} -out ${csrPath} -subj "/CN=${serverFullDomain}" -config ${configPath}`
      );

      // Sign certificate with CA
      execSync(
        `openssl x509 -req -in ${csrPath} -CA ${CA_CERT_PATH} -CAkey ${CA_KEY_PATH} -CAcreateserial -out ${certPath} -days 365 -extensions v3_req -extfile ${configPath}`
      );

      // Set permissions
      await fs.chmod(keyPath, 0o600);
      await fs.chmod(certPath, 0o644);

      // Return certificate data
      const caCert = await fs.readFile(CA_CERT_PATH, "utf8");
      const serverKey = await fs.readFile(keyPath, "utf8");
      const serverCert = await fs.readFile(certPath, "utf8");

      logger.info(`Certificate generated for agent ${agentId}`);

      return {
        success: true,
        caCert,
        serverKey,
        serverCert,
        paths: {
          caCert: CA_CERT_PATH,
          serverKey: keyPath,
          serverCert: certPath,
        },
      };
    } catch (err) {
      logger.error(
        `Failed to generate certificate for agent ${agentId}: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
          agentId,
        }
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
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const caCert = await fs.readFile(CA_CERT_PATH, "utf8");
      return {
        success: true,
        caCert,
      };
    } catch (err) {
      logger.error(`Failed to read CA certificate: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });

      return {
        success: false,
        error: err.message,
      };
    }
  }
}

module.exports = new CertificateService();
