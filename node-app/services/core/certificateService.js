/**
 * Certificate Service
 *
 * Handles certificate generation, storage, and distribution using HAProxy Data Plane API
 */

const fs = require("fs").promises;
const path = require("path");
const { execSync } = require("child_process");
const logger = require("../../utils/logger").getLogger("certificateService");
const { promisify } = require("util");
const execAsync = promisify(execSync);
const pathManager = require("../../utils/pathManager");
const axios = require("axios");
const { AppError } = require("../../utils/errorHandler");

class CertificateService {
  constructor() {
    this.initialized = false;
    this.certsDir = null;
    this.caCertPath = null;
    this.caKeyPath = null;
    this.mongoDomain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";

    // Data Plane API configuration
    this.apiBaseUrl = process.env.HAPROXY_API_URL || "http://localhost:5555/v2";
    this.apiUsername = process.env.HAPROXY_API_USER || "admin";
    this.apiPassword = process.env.HAPROXY_API_PASS || "admin";
  }

  /**
   * Initialize the certificate service
   */
  async initialize() {
    logger.info("Initializing certificate service");

    try {
      // Initialize path manager if needed
      if (!pathManager.initialized) {
        await pathManager.initialize();
      }

      // Set paths from path manager
      this.certsDir = pathManager.getPath("certs");
      this.caCertPath = pathManager.getPath("caCert");
      this.caKeyPath = pathManager.getPath("caKey");

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
   * Create axios instance with auth for Data Plane API
   * @returns {Object} Configured axios instance
   */
  _getApiClient() {
    return axios.create({
      baseURL: this.apiBaseUrl,
      auth: {
        username: this.apiUsername,
        password: this.apiPassword,
      },
      timeout: 10000,
    });
  }

  /**
   * Ensure certificates directory exists
   */
  async _ensureCertsDir() {
    try {
      // Create certificates directory
      await fs.mkdir(this.certsDir, { recursive: true });

      // Create agents subdirectory
      await fs.mkdir(path.join(this.certsDir, "agents"), { recursive: true });

      logger.info(`Certificates directory created at ${this.certsDir}`);
      return true;
    } catch (err) {
      logger.error(`Failed to create certificates directory: ${err.message}`);
      throw err;
    }
  }

  /**
   * Ensure CA certificate exists
   */
  async _ensureCA() {
    const caExists = await this.checkCAExists();
    if (!caExists) {
      await this.generateCA();
    }
    return true;
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
    } catch (_accessErr) {
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
   * Create certificate for an agent and update HAProxy via Data Plane API
   * @param {string} agentId - Agent ID
   * @param {string} targetIp - Target IP address
   * @returns {Promise<Object>} Result with certificate paths
   */
  async createCertificateForAgent(agentId, targetIp) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info(`Creating certificate for agent ${agentId}`);

      // Create agent directory
      const agentCertDir = path.join(this.certsDir, "agents", agentId);
      await fs.mkdir(agentCertDir, { recursive: true });

      // Define paths
      const keyPath = path.join(agentCertDir, "server.key");
      const csrPath = path.join(agentCertDir, "server.csr");
      const certPath = path.join(agentCertDir, "server.crt");
      const pemPath = path.join(agentCertDir, "server.pem");
      const configPath = path.join(agentCertDir, "openssl.cnf");
      const mongoSubdomain = `${agentId}.${this.mongoDomain}`;

      // Create OpenSSL configuration
      const opensslConfig = `
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = ${mongoSubdomain}

[v3_req]
keyUsage = keyEncipherment, dataEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = ${mongoSubdomain}
DNS.2 = *.${mongoSubdomain}
DNS.3 = ${targetIp}
IP.1 = ${targetIp}
`;

      // Write OpenSSL configuration
      await fs.writeFile(configPath, opensslConfig);

      // Generate private key
      execSync(`openssl genrsa -out ${keyPath} 2048`);

      // Generate CSR
      execSync(
        `openssl req -new -key ${keyPath} -out ${csrPath} -config ${configPath}`
      );

      // Sign certificate with CA
      execSync(
        `openssl x509 -req -in ${csrPath} -CA ${this.caCertPath} -CAkey ${this.caKeyPath} -CAcreateserial -out ${certPath} -days 365 -extensions v3_req -extfile ${configPath}`
      );

      // Create combined PEM file for HAProxy
      const certContent = await fs.readFile(certPath, "utf8");
      const keyContent = await fs.readFile(keyPath, "utf8");
      const pemContent = certContent + keyContent;
      await fs.writeFile(pemPath, pemContent);

      // Set permissions
      await fs.chmod(keyPath, 0o600);
      await fs.chmod(certPath, 0o644);
      await fs.chmod(pemPath, 0o600);

      // Copy certificates to HAProxy certificate directory
      await this.updateHAProxyCertificates(agentId, certPath, keyPath, pemPath);

      logger.info(`Certificate created for agent ${agentId}`);
      return {
        success: true,
        keyPath,
        certPath,
        pemPath,
        caPath: this.caCertPath,
      };
    } catch (err) {
      logger.error(
        `Failed to create certificate for agent ${agentId}: ${err.message}`
      );
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Update HAProxy certificates through Data Plane API
   * @param {string} agentId - Agent ID
   * @param {string} certPath - Path to server certificate
   * @param {string} keyPath - Path to server key
   * @param {string} pemPath - Path to combined PEM file
   * @returns {Promise<Object>} Result of the operation
   */
  async updateHAProxyCertificates(agentId, certPath, keyPath, pemPath) {
    try {
      logger.info(`Updating HAProxy certificates for agent ${agentId}`);

      // Copy files to system locations for HAProxy
      const haproxyCertsDir = "/etc/ssl/certs";
      const haproxyPrivateDir = "/etc/ssl/private";

      try {
        // Create directories if they don't exist
        await fs.mkdir(haproxyCertsDir, { recursive: true });
        await fs.mkdir(haproxyPrivateDir, { recursive: true });

        // Copy certificate and key
        const certsFilename = `${agentId}-mongodb.crt`;
        const keyFilename = `${agentId}-mongodb.key`;
        const pemFilename = `${agentId}-mongodb.pem`;

        const targetCertPath = path.join(haproxyCertsDir, certsFilename);
        const targetKeyPath = path.join(haproxyPrivateDir, keyFilename);
        const targetPemPath = path.join(haproxyPrivateDir, pemFilename);

        await fs.copyFile(certPath, targetCertPath);
        await fs.copyFile(keyPath, targetKeyPath);
        await fs.copyFile(pemPath, targetPemPath);

        await fs.chmod(targetCertPath, 0o644);
        await fs.chmod(targetKeyPath, 0o600);
        await fs.chmod(targetPemPath, 0o600);

        logger.info(
          `Copied certificates to HAProxy directories for agent ${agentId}`
        );

        // Update HAProxy configuration via Data Plane API
        return this.updateHAProxyTlsConfig(agentId, targetPemPath);
      } catch (copyErr) {
        logger.warn(
          `Failed to copy certificates to system locations: ${copyErr.message}`
        );
        // Even if copying to system locations fails, try to update HAProxy via the API
        return this.updateHAProxyTlsConfig(agentId, pemPath);
      }
    } catch (err) {
      logger.error(`Failed to update HAProxy certificates: ${err.message}`);
      throw err;
    }
  }

  /**
   * Update HAProxy TLS configuration via Data Plane API
   * @param {string} agentId - Agent ID
   * @param {string} pemPath - Path to PEM file
   * @returns {Promise<Object>} Result of the operation
   */
  async updateHAProxyTlsConfig(agentId, pemPath) {
    try {
      const client = this._getApiClient();

      // Start a transaction
      const transactionResponse = await client.post(
        "/services/haproxy/transactions"
      );
      const transactionId = transactionResponse.data.id;

      logger.info(
        `Started HAProxy transaction ${transactionId} for TLS config update`
      );

      // Update MongoDB backend SSL configuration
      try {
        // Create or update SSL certificate store for MongoDB
        const certStoreName = `mongodb_${agentId}_certs`;

        // Check if certificate store exists
        let certStoreExists = false;
        try {
          await client.get(
            `/services/haproxy/configuration/certificate_stores/${certStoreName}?transaction_id=${transactionId}`
          );
          certStoreExists = true;
        } catch (err) {
          // Certificate store doesn't exist
          certStoreExists = false;
        }

        // Create or update certificate store
        if (certStoreExists) {
          await client.put(
            `/services/haproxy/configuration/certificate_stores/${certStoreName}?transaction_id=${transactionId}`,
            {
              crt_list: pemPath,
            }
          );
        } else {
          await client.post(
            `/services/haproxy/configuration/certificate_stores?transaction_id=${transactionId}`,
            {
              name: certStoreName,
              crt_list: pemPath,
            }
          );
        }

        // Set SSL configuration on the backend for the agent
        const backendName = `${agentId}-mongodb-backend`;

        // Check if backend exists
        let backendExists = false;
        try {
          await client.get(
            `/services/haproxy/configuration/backends/${backendName}?transaction_id=${transactionId}`
          );
          backendExists = true;
        } catch (err) {
          // Backend doesn't exist yet
          backendExists = false;
        }

        // Update backend SSL configuration
        if (backendExists) {
          await client.put(
            `/services/haproxy/configuration/backends/${backendName}?transaction_id=${transactionId}`,
            {
              ssl: {
                enabled: true,
                verify: "none",
                ca_file: this.caCertPath,
                crt_list: pemPath,
              },
            }
          );
        }

        // Commit the transaction
        await client.put(`/services/haproxy/transactions/${transactionId}`);
        logger.info(
          `Committed HAProxy transaction ${transactionId} for TLS config update`
        );

        return {
          success: true,
          message: `Updated HAProxy TLS configuration for agent ${agentId}`,
        };
      } catch (err) {
        // Delete the transaction on error
        try {
          await client.delete(
            `/services/haproxy/transactions/${transactionId}`
          );
          logger.warn(
            `Deleted HAProxy transaction ${transactionId} due to error`
          );
        } catch (deleteErr) {
          logger.error(
            `Failed to delete HAProxy transaction ${transactionId}: ${deleteErr.message}`
          );
        }

        throw err;
      }
    } catch (err) {
      logger.error(`Failed to update HAProxy TLS config: ${err.message}`);
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Get certificate information
   * @param {string} agentId - Agent ID
   * @returns {Promise<Object>} Certificate information
   */
  async getCertificateInfo(agentId) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      const agentCertDir = path.join(this.certsDir, "agents", agentId);
      const certPath = path.join(agentCertDir, "server.crt");

      // Check if certificate exists
      try {
        await fs.access(certPath);
      } catch (_err) {
        return {
          success: false,
          exists: false,
          message: `Certificate does not exist for agent ${agentId}`,
        };
      }

      // Get certificate info
      const certInfo = execSync(
        `openssl x509 -in ${certPath} -text -noout`
      ).toString();

      // Parse expiration date
      const expiryMatch = certInfo.match(/Not After\s*:\s*(.+)/);
      const expiry = expiryMatch ? new Date(expiryMatch[1]) : null;
      const now = new Date();
      const daysRemaining = expiry
        ? Math.ceil((expiry - now) / (1000 * 60 * 60 * 24))
        : 0;

      return {
        success: true,
        exists: true,
        certPath,
        caPath: this.caCertPath,
        expiry: expiry ? expiry.toISOString() : null,
        daysRemaining,
        isExpired: daysRemaining <= 0,
        summary: certInfo,
      };
    } catch (err) {
      logger.error(
        `Failed to get certificate info for agent ${agentId}: ${err.message}`
      );
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Renew certificate for an agent
   * @param {string} agentId - Agent ID
   * @param {string} targetIp - Target IP address
   * @returns {Promise<Object>} Result with certificate paths
   */
  async renewCertificate(agentId, targetIp) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info(`Renewing certificate for agent ${agentId}`);

      // First, check if certificate exists
      const certInfo = await this.getCertificateInfo(agentId);

      if (!certInfo.exists) {
        // If certificate doesn't exist, create a new one
        return this.createCertificateForAgent(agentId, targetIp);
      }

      // Create a new certificate
      return this.createCertificateForAgent(agentId, targetIp);
    } catch (err) {
      logger.error(
        `Failed to renew certificate for agent ${agentId}: ${err.message}`
      );
      return {
        success: false,
        error: err.message,
      };
    }
  }
}

module.exports = CertificateService;
