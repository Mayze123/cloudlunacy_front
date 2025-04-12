/**
 * ACME Certificate Provider
 *
 * Implements certificate issuance and renewal using the ACME protocol
 * Compatible with Let's Encrypt and other ACME CA providers
 */

const fs = require("fs").promises;
const path = require("path");
const { exec } = require("child_process");
const util = require("util");
const execAsync = util.promisify(exec);
const BaseCertProvider = require("./baseCertProvider");
const logger = require("../logger").getLogger("acmeProvider");
const { AppError } = require("../errorHandler");

class AcmeProvider extends BaseCertProvider {
  /**
   * Create a new ACME provider instance
   * @param {Object} config - Configuration options
   */
  constructor(config = {}) {
    super(config);

    // ACME-specific configuration
    this.accountEmail = config.accountEmail;
    this.acmeServer =
      config.acmeServer || "https://acme-v02.api.letsencrypt.org/directory"; // Production by default
    this.acmeStaging = config.acmeStaging === true;
    this.challengeType = config.challengeType || "http";
    this.webRootPath = config.webRootPath;
    this.dnsProvider = config.dnsProvider;
    this.dnsCredentials = config.dnsCredentials || {};

    // Override default validity days for ACME
    this.validityDays = config.validityDays || 90; // Let's Encrypt default

    // Path to store ACME account information
    this.acmeAccountDir = path.join(this.certsDir, "acme-account");

    if (this.acmeStaging) {
      this.acmeServer =
        "https://acme-staging-v02.api.letsencrypt.org/directory";
    }

    // Check for certbot command
    this.hasCertbot = false;
    this.clientType = "certbot"; // Default to certbot, can be extended to support other clients
  }

  /**
   * @inheritdoc
   */
  async initialize() {
    try {
      await super.initialize();

      // Create ACME account directory if it doesn't exist
      await fs.mkdir(this.acmeAccountDir, { recursive: true });

      // Check if certbot is available
      try {
        await execAsync("which certbot");
        this.hasCertbot = true;
      } catch (err) {
        logger.warn("Certbot not found in PATH, ACME provider will be limited");
        this.hasCertbot = false;
      }

      // Check for required configuration
      if (!this.accountEmail) {
        logger.warn(
          "No ACME account email provided, provider may have limited functionality"
        );
      }

      if (this.challengeType === "dns" && !this.dnsProvider) {
        logger.warn("DNS challenge selected but no DNS provider specified");
      }

      if (this.challengeType === "http" && !this.webRootPath) {
        logger.warn("HTTP challenge selected but no webroot path specified");
      }

      logger.info(`ACME provider initialized with server: ${this.acmeServer}`);
      return true;
    } catch (err) {
      logger.error(`Failed to initialize ACME provider: ${err.message}`);
      throw new AppError(
        `ACME provider initialization failed: ${err.message}`,
        500
      );
    }
  }

  /**
   * @inheritdoc
   */
  getProviderInfo() {
    return {
      name: "ACME",
      type: "acme",
      description:
        "Issues certificates using the ACME protocol (Let's Encrypt)",
      isExternal: true,
      supportsWildcard: this.challengeType === "dns",
      validityPeriod: this.validityDays,
      status: this.hasCertbot ? "available" : "limited",
      features: {
        autoRenewal: true,
        revokeSupported: true,
        wildcardSupported: this.challengeType === "dns",
      },
    };
  }

  /**
   * @inheritdoc
   */
  async validateConfiguration() {
    const issues = [];

    if (!this.accountEmail) {
      issues.push({
        level: "warning",
        message: "No ACME account email provided",
      });
    }

    if (!this.hasCertbot) {
      issues.push({
        level: "error",
        message:
          "Certbot not found, ACME provider requires certbot to be installed",
      });
    }

    if (this.challengeType === "dns") {
      if (!this.dnsProvider) {
        issues.push({
          level: "error",
          message: "DNS challenge requires a DNS provider to be specified",
        });
      }

      if (Object.keys(this.dnsCredentials).length === 0) {
        issues.push({
          level: "warning",
          message:
            "DNS credentials may be required for automated DNS challenge",
        });
      }
    }

    if (this.challengeType === "http" && !this.webRootPath) {
      issues.push({
        level: "warning",
        message: "HTTP challenge should have a webroot path configured",
      });
    }

    // Check if we can access the ACME server
    try {
      const { stdout, stderr } = await execAsync(
        `curl -s -I ${this.acmeServer}`
      );
      if (stderr) {
        issues.push({
          level: "warning",
          message: `Connection to ACME server reported warnings: ${stderr}`,
        });
      }
    } catch (err) {
      issues.push({
        level: "error",
        message: `Cannot connect to ACME server: ${err.message}`,
      });
    }

    return {
      valid: issues.filter((issue) => issue.level === "error").length === 0,
      issues,
    };
  }

  /**
   * @inheritdoc
   */
  async generateCertificate(domain, options = {}) {
    if (!this.hasCertbot) {
      throw new AppError("Certbot not found, cannot issue certificates", 500);
    }

    const {
      subjectAltNames = [],
      isWildcard = false,
      isRenewal = false,
      force = false,
    } = options;

    // Build domain arguments
    let domainArgs = `-d ${domain}`;

    // Add wildcard if requested
    if (isWildcard) {
      if (this.challengeType !== "dns") {
        throw new AppError("Wildcard certificates require DNS challenge", 400);
      }
      domainArgs += ` -d *.${domain}`;
    }

    // Add subject alternative names
    for (const san of subjectAltNames) {
      domainArgs += ` -d ${san}`;
    }

    // Build command based on challenge type
    let certbotCmd = `certbot certonly --non-interactive`;

    // Add email
    if (this.accountEmail) {
      certbotCmd += ` --email ${this.accountEmail}`;
    } else {
      certbotCmd += ` --register-unsafely-without-email`;
    }

    // Add challenge type specific args
    if (this.challengeType === "http") {
      const webroot = this.webRootPath || "/var/www/html";
      certbotCmd += ` --webroot --webroot-path ${webroot}`;
    } else if (this.challengeType === "dns") {
      if (this.dnsProvider) {
        certbotCmd += ` --dns-${this.dnsProvider}`;

        // Handle credentials if provided
        if (Object.keys(this.dnsCredentials).length > 0) {
          // Create temporary credentials file
          const credentialsPath = path.join(
            this.acmeAccountDir,
            `${this.dnsProvider}-credentials.ini`
          );
          let credContent = "";

          for (const [key, value] of Object.entries(this.dnsCredentials)) {
            credContent += `${key} = ${value}\n`;
          }

          await fs.writeFile(credentialsPath, credContent, { mode: 0o600 });
          certbotCmd += ` --dns-${this.dnsProvider}-credentials ${credentialsPath}`;
        }
      } else {
        throw new AppError(
          "DNS challenge selected but no DNS provider specified",
          400
        );
      }
    } else {
      throw new AppError(
        `Unsupported challenge type: ${this.challengeType}`,
        400
      );
    }

    // Add domain args
    certbotCmd += ` ${domainArgs}`;

    // Force renewal if requested
    if (isRenewal && force) {
      certbotCmd += " --force-renewal";
    }

    // Add staging flag if enabled
    if (this.acmeStaging) {
      certbotCmd += " --staging";
    }

    // Set cert name for easier management
    const certName = domain.replace(/\*/g, "wildcard").replace(/\./g, "_");
    certbotCmd += ` --cert-name ${certName}`;

    // Agree to terms
    certbotCmd += " --agree-tos";

    logger.info(`Executing certbot command: ${certbotCmd}`);

    try {
      const { stdout, stderr } = await execAsync(certbotCmd);
      logger.info(`Certbot output: ${stdout}`);

      if (stderr) {
        logger.warn(`Certbot warnings: ${stderr}`);
      }

      // Find the generated certificate paths
      const certPath = `/etc/letsencrypt/live/${certName}/fullchain.pem`;
      const keyPath = `/etc/letsencrypt/live/${certName}/privkey.pem`;

      // Check if files exist
      try {
        await fs.access(certPath);
        await fs.access(keyPath);
      } catch (err) {
        throw new AppError(
          `Certificate files not found after generation: ${err.message}`,
          500
        );
      }

      // Copy certificates to our certificate directory
      const targetCertPath = path.join(this.certsDir, `${domain}.crt`);
      const targetKeyPath = path.join(this.certsDir, `${domain}.key`);

      await fs.copyFile(certPath, targetCertPath);
      await fs.copyFile(keyPath, targetKeyPath);

      // Return paths to the generated certificates
      return {
        success: true,
        domain,
        certPath: targetCertPath,
        keyPath: targetKeyPath,
        isWildcard,
        source: "acme",
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
    return this.generateCertificate(domain, {
      ...options,
      isRenewal: true,
    });
  }

  /**
   * @inheritdoc
   */
  async revokeCertificate(domain, reason = "") {
    if (!this.hasCertbot) {
      throw new AppError("Certbot not found, cannot revoke certificates", 500);
    }

    // Prepare certbot command for revocation
    const certName = domain.replace(/\*/g, "wildcard").replace(/\./g, "_");
    let revokeCertCmd = `certbot revoke --cert-name ${certName} --non-interactive`;

    // Add reason if provided
    if (reason) {
      // Map reason strings to certbot reason codes
      const reasonCodes = {
        keyCompromise: "keyCompromise",
        caCompromise: "caCompromise",
        affiliationChanged: "affiliationChanged",
        superseded: "superseded",
        cessationOfOperation: "cessationOfOperation",
      };

      if (reasonCodes[reason]) {
        revokeCertCmd += ` --reason ${reasonCodes[reason]}`;
      }
    }

    logger.info(`Executing revoke command: ${revokeCertCmd}`);

    try {
      const { stdout, stderr } = await execAsync(revokeCertCmd);
      logger.info(`Revocation output: ${stdout}`);

      if (stderr) {
        logger.warn(`Revocation warnings: ${stderr}`);
      }

      // Remove local copies of the certificates
      const certPath = path.join(this.certsDir, `${domain}.crt`);
      const keyPath = path.join(this.certsDir, `${domain}.key`);

      try {
        await fs.unlink(certPath);
        await fs.unlink(keyPath);
      } catch (err) {
        logger.warn(`Could not remove local certificate files: ${err.message}`);
      }

      return {
        success: true,
        domain,
        message: "Certificate successfully revoked",
      };
    } catch (err) {
      logger.error(`Certificate revocation failed: ${err.message}`);
      return {
        success: false,
        domain,
        error: err.message,
        output: err.stdout || "",
      };
    }
  }
}

module.exports = AcmeProvider;
