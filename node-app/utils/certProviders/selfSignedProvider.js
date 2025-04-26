/**
 * Self-Signed Certificate Provider
 *
 * Implements certificate issuance and renewal using OpenSSL to generate
 * self-signed certificates
 */

const fs = require("fs").promises;
const path = require("path");
const { exec } = require("child_process");
const util = require("util");
const execAsync = util.promisify(exec);
const BaseCertProvider = require("./baseCertProvider");
const logger = require("../logger").getLogger("selfSignedProvider");
const { AppError } = require("../errorHandler");

class SelfSignedProvider extends BaseCertProvider {
  /**
   * Create a new self-signed provider instance
   * @param {Object} config - Configuration options
   */
  constructor(config = {}) {
    super(config);

    // Self-signed specific config
    this.country = config.country || "US";
    this.state = config.state || "California";
    this.locality = config.locality || "San Francisco";
    this.organization = config.organization || "CloudLunacy";
    this.organizationalUnit = config.organizationalUnit || "IT";
    this.commonName = config.commonName || "localhost";
    this.caKeyPath = config.caKeyPath || path.join(this.certsDir, "ca.key");
    this.caCertPath = config.caCertPath || path.join(this.certsDir, "ca.crt");
  }

  /**
   * @inheritdoc
   */
  async initialize() {
    try {
      await super.initialize();

      // Check if CA cert and key exist, if not generate them
      try {
        await fs.access(this.caKeyPath);
        await fs.access(this.caCertPath);
        logger.info("CA certificate and key found, using existing CA");
      } catch (err) {
        logger.info("CA certificate or key not found, generating new CA");
        await this.generateCA();
      }

      return true;
    } catch (err) {
      logger.error(
        `Self-signed provider initialization failed: ${err.message}`
      );
      throw new AppError(
        `Self-signed provider initialization failed: ${err.message}`,
        500
      );
    }
  }

  /**
   * @inheritdoc
   */
  getProviderInfo() {
    return {
      name: "Self-Signed",
      type: "self-signed",
      description: "Generates self-signed certificates using OpenSSL",
      isExternal: false,
      supportsWildcard: true,
      validityPeriod: this.validityDays,
      status: "available",
      features: {
        autoRenewal: true,
        revokeSupported: false,
        wildcardSupported: true,
      },
    };
  }

  /**
   * @inheritdoc
   */
  async validateConfiguration() {
    const issues = [];

    // Check that we have access to OpenSSL
    try {
      await execAsync("openssl version");
    } catch (err) {
      issues.push({
        level: "error",
        message: "OpenSSL is not available or executable",
      });
    }

    // Check directories are writable
    try {
      await fs.access(this.certsDir, fs.constants.W_OK);
    } catch (err) {
      issues.push({
        level: "error",
        message: `Certificates directory (${this.certsDir}) is not writable`,
      });
    }

    return {
      valid: issues.filter((issue) => issue.level === "error").length === 0,
      issues,
    };
  }

  /**
   * Generate a CA certificate and key
   * @private
   */
  async generateCA() {
    // Create the CA key
    const genKeyCmd = `openssl genrsa -out "${this.caKeyPath}" ${this.keySize}`;

    try {
      logger.info(`Generating CA key: ${genKeyCmd}`);
      await execAsync(genKeyCmd);

      // Set permissions on the key
      await fs.chmod(this.caKeyPath, 0o600);

      // Create OpenSSL config for CA with proper extensions
      const caCnfPath = path.join(this.certsDir, `ca.cnf`);
      const caCnfContent = `
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_ca
prompt = no

[req_distinguished_name]
C = ${this.country}
ST = ${this.state}
L = ${this.locality}
O = ${this.organization}
OU = ${this.organizationalUnit}
CN = CloudLunacy CA

[v3_ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign,digitalSignature
`;

      await fs.writeFile(caCnfPath, caCnfContent);

      // Create the CA certificate with proper extensions
      const genCertCmd = `openssl req -new -x509 -key "${this.caKeyPath}" -out "${this.caCertPath}" -days 3650 -config "${caCnfPath}" -extensions v3_ca`;

      logger.info(`Generating CA certificate: ${genCertCmd}`);
      await execAsync(genCertCmd);

      // Clean up temporary config file
      await fs.unlink(caCnfPath);

      logger.info("CA certificate and key generated successfully");
      return true;
    } catch (err) {
      logger.error(`Failed to generate CA: ${err.message}`);
      throw new AppError(`Failed to generate CA: ${err.message}`, 500);
    }
  }

  /**
   * @inheritdoc
   */
  async generateCertificate(domain, options = {}) {
    const {
      subjectAltNames = [],
      isWildcard = false,
      isRenewal = false,
      force = false,
    } = options;

    // If renewal and not forced, check if certificate exists and skip if not needed
    if (isRenewal && !force) {
      const exists = await this.certificateExists(domain);
      if (!exists) {
        return {
          success: false,
          domain,
          error: "Certificate does not exist for renewal",
        };
      }
    }

    logger.info(`Generating certificate for domain: ${domain}`);

    // Create output paths
    const keyPath = path.join(this.certsDir, `${domain}.key`);
    const csrPath = path.join(this.certsDir, `${domain}.csr`);
    const crtPath = path.join(this.certsDir, `${domain}.crt`);
    const cnfPath = path.join(this.certsDir, `${domain}.cnf`);

    try {
      // Step 1: Generate key
      const genKeyCmd = `openssl genrsa -out "${keyPath}" ${this.keySize}`;
      logger.info(`Generating key: ${genKeyCmd}`);
      await execAsync(genKeyCmd);
      await fs.chmod(keyPath, 0o600);

      // Step 2: Create OpenSSL config for SAN support with proper KeyUsage and ExtendedKeyUsage for MongoDB Compass
      let cnfContent = `
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
prompt = no

[req_distinguished_name]
C = ${this.country}
ST = ${this.state}
L = ${this.locality}
O = ${this.organization}
OU = ${this.organizationalUnit}
CN = ${domain}

[v3_req]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth,clientAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = ${domain}
`;

      // Add wildcard as SAN if requested
      let nextIndex = 2;
      if (isWildcard) {
        cnfContent += `DNS.${nextIndex} = *.${domain}\n`;
        nextIndex++;
      }

      // Add additional SANs
      for (let i = 0; i < subjectAltNames.length; i++) {
        cnfContent += `DNS.${nextIndex + i} = ${subjectAltNames[i]}\n`;
      }

      await fs.writeFile(cnfPath, cnfContent);

      // Step 3: Generate CSR
      const genCsrCmd = `openssl req -new -key "${keyPath}" -out "${csrPath}" -config "${cnfPath}"`;
      logger.info(`Generating CSR: ${genCsrCmd}`);
      await execAsync(genCsrCmd);

      // Step 4: Sign the certificate with our CA
      const signCertCmd = `openssl x509 -req -in "${csrPath}" -CA "${this.caCertPath}" -CAkey "${this.caKeyPath}" -CAcreateserial -out "${crtPath}" -days ${this.validityDays} -extensions v3_req -extfile "${cnfPath}"`;
      logger.info(`Signing certificate: ${signCertCmd}`);
      await execAsync(signCertCmd);

      // Step 5: Clean up temporary files
      await fs.unlink(csrPath);
      await fs.unlink(cnfPath);

      logger.info(`Certificate generated successfully for ${domain}`);

      return {
        success: true,
        domain,
        certPath: crtPath,
        keyPath: keyPath,
        isWildcard,
        source: "self-signed",
        validityDays: this.validityDays,
      };
    } catch (err) {
      logger.error(`Certificate generation failed: ${err.message}`);
      return {
        success: false,
        domain,
        error: err.message,
        output: err.stdout || "",
      };
    }
  }

  /**
   * @inheritdoc
   */
  async renewCertificate(domain, options = {}) {
    logger.info(`Renewing certificate for domain: ${domain}`);
    // For self-signed certs, renewal is the same as generation
    return this.generateCertificate(domain, {
      ...options,
      isRenewal: true,
    });
  }

  /**
   * @inheritdoc
   */
  async revokeCertificate(domain, reason = "") {
    logger.info(`Revoking certificate for domain: ${domain}`);
    try {
      // For self-signed, we just delete the certificate
      const certPath = path.join(this.certsDir, `${domain}.crt`);
      const keyPath = path.join(this.certsDir, `${domain}.key`);

      await fs.unlink(certPath);
      await fs.unlink(keyPath);

      return {
        success: true,
        domain,
        message: "Certificate removed successfully",
      };
    } catch (err) {
      logger.error(`Failed to revoke certificate: ${err.message}`);
      return {
        success: false,
        domain,
        error: err.message,
      };
    }
  }
}

module.exports = SelfSignedProvider;
