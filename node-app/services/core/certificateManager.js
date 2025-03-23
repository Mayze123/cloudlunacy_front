/**
 * Certificate Manager
 *
 * Handles certificate generation, storage, and distribution for MongoDB TLS
 * Uses node-forge instead of shell commands for improved security and maintainability
 */

const fs = require("fs").promises;
const path = require("path");
const forge = require("node-forge");
const logger = require("../../utils/logger").getLogger("certificateManager");
const pathManager = require("../../utils/pathManager");

class CertificateManager {
  constructor(configManager) {
    this.configManager = configManager;
    this.initialized = false;
    this.certsDir = null;
    this.caCertPath = null;
    this.caKeyPath = null;
    this.mongoDomain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
    this.certCache = new Map(); // Cache for certificates
  }

  /**
   * Initialize the certificate manager
   */
  async initialize() {
    logger.info("Initializing certificate manager");

    try {
      // Initialize path manager if needed
      if (!pathManager.initialized) {
        await pathManager.initialize();
      }

      // Set paths from path manager
      this.certsDir = pathManager.getPath("certs");
      this.caCertPath = pathManager.getPath("caCert");
      this.caKeyPath = pathManager.getPath("caKey");
      this.agentCertsDir = path.join(this.certsDir, "agents");

      // Ensure certificates directory exists
      await this._ensureCertsDir();

      // Ensure CA certificate exists
      await this._ensureCA();

      this.initialized = true;
      logger.info("Certificate manager initialized successfully");
      return true;
    } catch (err) {
      logger.error(`Failed to initialize certificate manager: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return false;
    }
  }

  /**
   * Ensure certificates directory exists
   */
  async _ensureCertsDir() {
    try {
      await fs.mkdir(this.certsDir, { recursive: true });
      await fs.mkdir(this.agentCertsDir, { recursive: true });
      logger.debug(
        `Ensured certificates directories exist: ${this.certsDir}, ${this.agentCertsDir}`
      );
      return true;
    } catch (err) {
      logger.error(`Failed to create certificates directory: ${err.message}`);
      throw err;
    }
  }

  /**
   * Ensure CA certificate exists, create if not
   */
  async _ensureCA() {
    try {
      const caExists = await this.checkCAExists();
      if (!caExists) {
        await this.generateCA();
      }
      return true;
    } catch (err) {
      logger.error(`Failed to ensure CA certificate: ${err.message}`);
      throw err;
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
    } catch {
      logger.info("CA certificate or key not found, will generate new ones");
      return false;
    }
  }

  /**
   * Generate CA certificate using node-forge
   */
  async generateCA() {
    try {
      logger.info("Generating new CA certificate and key");

      // Create a new RSA keypair with 2048 bits
      const keys = forge.pki.rsa.generateKeyPair(2048);

      // Create a certificate
      const cert = forge.pki.createCertificate();
      cert.publicKey = keys.publicKey;

      // Set certificate fields
      cert.serialNumber =
        "01" + Math.floor(Math.random() * 1000000000).toString();

      // Set validity period (10 years)
      const now = new Date();
      cert.validity.notBefore = now;
      cert.validity.notAfter = new Date();
      cert.validity.notAfter.setFullYear(now.getFullYear() + 10);

      // Set subject and issuer attributes
      const attrs = [
        { name: "commonName", value: "CloudLunacy MongoDB CA" },
        { name: "organizationName", value: "CloudLunacy" },
        { name: "countryName", value: "UK" },
      ];
      cert.setSubject(attrs);
      cert.setIssuer(attrs); // Self-signed, so subject = issuer

      // Set extensions
      cert.setExtensions([
        {
          name: "basicConstraints",
          cA: true,
          critical: true,
        },
        {
          name: "keyUsage",
          keyCertSign: true,
          cRLSign: true,
          critical: true,
        },
      ]);

      // Self-sign certificate with the private key
      cert.sign(keys.privateKey, forge.md.sha256.create());

      // Convert to PEM format
      const caCert = forge.pki.certificateToPem(cert);
      const caKey = forge.pki.privateKeyToPem(keys.privateKey);

      // Write to files
      await fs.writeFile(this.caCertPath, caCert);
      await fs.writeFile(this.caKeyPath, caKey);

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
   * Generate agent certificate using node-forge
   * @param {string} agentId - The agent ID
   * @param {string} targetIp - The target IP address
   */
  async generateAgentCertificate(agentId, targetIp = null) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info(`Generating certificate for agent ${agentId}`);

      // Check if we have a cached certificate
      const cacheKey = `${agentId}:${targetIp || "no-ip"}`;
      if (this.certCache.has(cacheKey)) {
        const cacheEntry = this.certCache.get(cacheKey);
        // Check if certificate is still valid and exists
        try {
          await fs.access(cacheEntry.certPath);
          logger.info(`Using cached certificate for agent ${agentId}`);
          return cacheEntry;
        } catch {
          // Certificate file doesn't exist, regenerate
          logger.info(
            `Cached certificate for agent ${agentId} not found, regenerating`
          );
        }
      }

      const certDir = path.join(this.agentCertsDir, agentId);
      await fs.mkdir(certDir, { recursive: true });

      const serverKeyPath = path.join(certDir, "server.key");
      const serverCertPath = path.join(certDir, "server.crt");
      const domain = `${agentId}.${this.mongoDomain}`;

      // Load CA certificate and key
      const caCertPem = await fs.readFile(this.caCertPath, "utf8");
      const caKeyPem = await fs.readFile(this.caKeyPath, "utf8");

      const caKey = forge.pki.privateKeyFromPem(caKeyPem);
      const caCert = forge.pki.certificateFromPem(caCertPem);

      // Create a new keypair for the server
      const keys = forge.pki.rsa.generateKeyPair(2048);

      // Create a new certificate
      const cert = forge.pki.createCertificate();
      cert.publicKey = keys.publicKey;

      // Set certificate fields
      cert.serialNumber =
        "02" + Math.floor(Math.random() * 1000000000).toString();

      // Set validity period (1 year)
      const now = new Date();
      cert.validity.notBefore = now;
      cert.validity.notAfter = new Date();
      cert.validity.notAfter.setFullYear(now.getFullYear() + 1);

      // Set subject
      cert.setSubject([{ name: "commonName", value: domain }]);

      // Set issuer (from CA cert)
      cert.setIssuer(caCert.subject.attributes);

      // Set extensions with Subject Alternative Names
      const altNames = [
        { type: 2, value: domain }, // DNS name
        { type: 2, value: `*.${domain}` }, // Wildcard DNS
        { type: 2, value: "localhost" }, // Localhost DNS
        { type: 7, ip: "127.0.0.1" }, // IP address
      ];

      // Add target IP if provided
      if (targetIp && targetIp !== "127.0.0.1") {
        altNames.push({ type: 7, ip: targetIp });
      }

      cert.setExtensions([
        {
          name: "basicConstraints",
          cA: false,
        },
        {
          name: "keyUsage",
          digitalSignature: true,
          keyEncipherment: true,
          critical: true,
        },
        {
          name: "extKeyUsage",
          serverAuth: true,
          clientAuth: true,
        },
        {
          name: "subjectAltName",
          altNames: altNames,
        },
      ]);

      // Sign certificate with the CA private key
      cert.sign(caKey, forge.md.sha256.create());

      // Convert to PEM format
      const serverCert = forge.pki.certificateToPem(cert);
      const serverKey = forge.pki.privateKeyToPem(keys.privateKey);

      // Write to files
      await fs.writeFile(serverKeyPath, serverKey);
      await fs.writeFile(serverCertPath, serverCert);

      // Set proper permissions
      await fs.chmod(serverKeyPath, 0o600);
      await fs.chmod(serverCertPath, 0o644);

      // Create a PEM bundle with cert and key
      const pemBundle = serverCert + serverKey;
      const pemBundlePath = path.join(certDir, "server.pem");
      await fs.writeFile(pemBundlePath, pemBundle);
      await fs.chmod(pemBundlePath, 0o600);

      // Cache the certificate information
      const result = {
        agentId,
        domain,
        keyPath: serverKeyPath,
        certPath: serverCertPath,
        pemPath: pemBundlePath,
        generatedAt: new Date().toISOString(),
      };

      this.certCache.set(cacheKey, result);

      logger.info(`Certificate for agent ${agentId} generated successfully`);
      return result;
    } catch (err) {
      logger.error(
        `Failed to generate certificate for agent ${agentId}: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
        }
      );
      throw err;
    }
  }

  /**
   * Get CA certificate content
   * @returns {Promise<string>} CA certificate content
   */
  async getCA() {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      const caCert = await fs.readFile(this.caCertPath, "utf8");
      return caCert;
    } catch (err) {
      logger.error(`Failed to get CA certificate: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get agent certificate files
   * @param {string} agentId - The agent ID
   * @returns {Promise<Object>} Object containing certificate file paths
   */
  async getAgentCertificates(agentId) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      const certDir = path.join(this.agentCertsDir, agentId);
      const serverKeyPath = path.join(certDir, "server.key");
      const serverCertPath = path.join(certDir, "server.crt");
      const pemBundlePath = path.join(certDir, "server.pem");

      // Check if the certificate exists
      try {
        await fs.access(serverCertPath);
      } catch {
        // Certificate doesn't exist, generate it
        logger.info(`Certificate for agent ${agentId} not found, generating`);
        await this.generateAgentCertificate(agentId);
      }

      // Read the certificate files
      const serverKey = await fs.readFile(serverKeyPath, "utf8");
      const serverCert = await fs.readFile(serverCertPath, "utf8");
      const caCert = await fs.readFile(this.caCertPath, "utf8");

      return {
        agentId,
        domain: `${agentId}.${this.mongoDomain}`,
        serverKey,
        serverCert,
        caCert,
        keyPath: serverKeyPath,
        certPath: serverCertPath,
        caPath: this.caCertPath,
        pemPath: pemBundlePath,
      };
    } catch (err) {
      logger.error(
        `Failed to get agent certificates for ${agentId}: ${err.message}`
      );
      throw err;
    }
  }

  /**
   * Revoke an agent certificate
   * @param {string} agentId - The agent ID
   */
  async revokeAgentCertificate(agentId) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info(`Revoking certificate for agent ${agentId}`);

      const certDir = path.join(this.agentCertsDir, agentId);

      // Remove from cache
      for (const [key, value] of this.certCache.entries()) {
        if (value.agentId === agentId) {
          this.certCache.delete(key);
        }
      }

      // Remove the certificate directory
      try {
        await fs.rm(certDir, { recursive: true, force: true });
        logger.info(`Certificate for agent ${agentId} revoked and removed`);
        return true;
      } catch (err) {
        logger.warn(
          `Failed to remove certificate directory for agent ${agentId}: ${err.message}`
        );
        // Not a fatal error, directory might not exist
        return true;
      }
    } catch (err) {
      logger.error(
        `Failed to revoke certificate for agent ${agentId}: ${err.message}`
      );
      throw err;
    }
  }
}

module.exports = CertificateManager;
