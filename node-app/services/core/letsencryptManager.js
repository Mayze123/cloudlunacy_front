/**
 * Let's Encrypt Certificate Manager
 *
 * Handles obtaining and renewing Let's Encrypt wildcard certificates
 * using Cloudflare DNS validation and ACME protocol
 */

const fs = require("fs").promises;
const path = require("path");
const acme = require("acme-client");
const cloudflare = require("cloudflare");
const { setTimeout } = require("timers/promises");
const logger = require("../../utils/logger").getLogger("letsencryptManager");
const pathManager = require("../../utils/pathManager");
const { AppError } = require("../../utils/errorHandler");
const { withRetry } = require("../../utils/retryHandler");

class LetsEncryptManager {
  constructor(configManager) {
    this.configManager = configManager;
    this.initialized = false;
    this.certsDir = null;
    this.acmeAccountKey = null;
    this.cloudflareClient = null;
    this.useProduction = process.env.NODE_ENV === "production";
    this.mongoDomain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
    this.letsencryptEmail = process.env.CF_EMAIL;
    this.cloudflareApiKey = process.env.CF_API_KEY;
    this.cloudflareDnsToken = process.env.CF_DNS_API_TOKEN;
    this.cloudflareZoneToken = process.env.CF_ZONE_API_TOKEN;
    this.acmeAccountKeyPath = null;
    this.certbotDir = null;
  }

  /**
   * Initialize the Let's Encrypt manager
   */
  async initialize() {
    logger.info("Initializing Let's Encrypt certificate manager");

    try {
      // Verify required environment variables
      if (!this.letsencryptEmail) {
        throw new Error("CF_EMAIL environment variable is required");
      }

      if (!this.cloudflareApiKey) {
        throw new Error("CF_API_KEY environment variable is required");
      }

      if (!this.cloudflareDnsToken) {
        throw new Error("CF_DNS_API_TOKEN environment variable is required");
      }

      // Initialize path manager if needed
      if (!pathManager.initialized) {
        await pathManager.initialize();
      }

      // Set paths from path manager
      this.certsDir = pathManager.getPath("certs");
      this.certbotDir = pathManager.getPath("certbot");
      this.acmeAccountKeyPath = path.join(this.certbotDir, "account.key");

      // Ensure directories exist
      await this._ensureDirectories();

      // Initialize Cloudflare client
      this.cloudflareClient = cloudflare({
        apiKey: this.cloudflareApiKey,
        email: this.letsencryptEmail,
        token: this.cloudflareZoneToken,
      });

      // Ensure we have ACME account key
      await this._ensureAcmeAccount();

      this.initialized = true;
      logger.info("Let's Encrypt certificate manager initialized successfully");
      return true;
    } catch (err) {
      logger.error(
        `Failed to initialize Let's Encrypt manager: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
        }
      );
      return false;
    }
  }

  /**
   * Ensure all required directories exist
   */
  async _ensureDirectories() {
    try {
      // Ensure certbot directory exists
      await fs.mkdir(this.certbotDir, { recursive: true });

      // Ensure certs directory exists
      await fs.mkdir(this.certsDir, { recursive: true });

      // Create www directory for HTTP challenge if needed
      await fs.mkdir(path.join(this.certbotDir, "www"), { recursive: true });

      // Create live directory if needed
      await fs.mkdir(path.join(this.certbotDir, "live", this.mongoDomain), {
        recursive: true,
      });

      logger.debug("Ensured Let's Encrypt directories exist");
      return true;
    } catch (err) {
      logger.error(
        `Failed to create Let's Encrypt directories: ${err.message}`
      );
      throw err;
    }
  }

  /**
   * Ensure we have ACME account key
   */
  async _ensureAcmeAccount() {
    try {
      try {
        // Try to read existing account key
        const keyData = await fs.readFile(this.acmeAccountKeyPath, "utf8");
        this.acmeAccountKey = keyData;
        logger.info("Loaded existing ACME account key");
      } catch {
        // Generate new account key
        logger.info("Generating new ACME account key");
        const accountKey = await acme.forge.createPrivateKey();

        // Save account key
        await fs.writeFile(this.acmeAccountKeyPath, accountKey.toString());

        // Set permissions to prevent other users from reading it
        await fs.chmod(this.acmeAccountKeyPath, 0o600);

        this.acmeAccountKey = accountKey.toString();
        logger.info("Generated new ACME account key");
      }

      return true;
    } catch (err) {
      logger.error(`Failed to ensure ACME account: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get Let's Encrypt directory URL based on environment
   */
  _getDirectoryUrl() {
    return this.useProduction
      ? acme.directory.letsencrypt.production
      : acme.directory.letsencrypt.staging;
  }

  /**
   * Create ACME client
   */
  async _createClient() {
    return new acme.Client({
      directoryUrl: this._getDirectoryUrl(),
      accountKey: this.acmeAccountKey,
    });
  }

  /**
   * Find Cloudflare zone ID for domain
   */
  async _getCloudflareZoneId() {
    try {
      // Extract base domain (e.g., cloudlunacy.uk from mongodb.cloudlunacy.uk)
      const domainParts = this.mongoDomain.split(".");
      const baseDomain =
        domainParts.length > 2
          ? `${domainParts[domainParts.length - 2]}.${
              domainParts[domainParts.length - 1]
            }`
          : this.mongoDomain;

      // Get zones
      const zones = await this.cloudflareClient.zones.browse();

      // Find matching zone
      const zone = zones.result.find((z) => z.name === baseDomain);

      if (!zone) {
        throw new Error(`No Cloudflare zone found for domain: ${baseDomain}`);
      }

      return zone.id;
    } catch (err) {
      logger.error(`Failed to get Cloudflare zone ID: ${err.message}`);
      throw err;
    }
  }

  /**
   * Create DNS records for ACME challenge
   * @param {string} dnsRecordName - Record name
   * @param {string} dnsRecordValue - Record value
   */
  async _createDnsRecord(dnsRecordName, dnsRecordValue) {
    try {
      // Get zone ID
      const zoneId = await this._getCloudflareZoneId();

      // Create TXT record
      await this.cloudflareClient.dnsRecords.add(zoneId, {
        type: "TXT",
        name: dnsRecordName,
        content: dnsRecordValue,
        ttl: 120,
      });

      logger.info(`Created DNS TXT record: ${dnsRecordName}`);
      return true;
    } catch (err) {
      logger.error(`Failed to create DNS record: ${err.message}`);
      throw err;
    }
  }

  /**
   * Remove DNS record after challenge is complete
   * @param {string} dnsRecordName - Record name
   */
  async _removeDnsRecord(dnsRecordName) {
    try {
      // Get zone ID
      const zoneId = await this._getCloudflareZoneId();

      // Get DNS records
      const records = await this.cloudflareClient.dnsRecords.browse(zoneId);

      // Find matching record
      const record = records.result.find(
        (r) => r.type === "TXT" && r.name === dnsRecordName
      );

      if (record) {
        // Delete the record
        await this.cloudflareClient.dnsRecords.del(zoneId, record.id);
        logger.info(`Removed DNS TXT record: ${dnsRecordName}`);
      } else {
        logger.warn(`DNS record not found for removal: ${dnsRecordName}`);
      }

      return true;
    } catch (err) {
      logger.error(`Failed to remove DNS record: ${err.message}`);
      // Don't throw, as this is cleanup and shouldn't fail the whole process
      return false;
    }
  }

  /**
   * DNS challenge solver for ACME
   */
  _dnsChallengeSolver(authz, _challenge, keyAuthorization) {
    return withRetry(
      async () => {
        // Get record name and value for Cloudflare
        const recordName = `_acme-challenge.${authz.identifier.value}`;
        const recordValue = keyAuthorization;

        try {
          // Create DNS record
          await this._createDnsRecord(recordName, recordValue);

          // Wait for DNS propagation (60 seconds)
          logger.info("Waiting 60 seconds for DNS propagation...");
          await setTimeout(60000);

          return true;
        } catch (err) {
          logger.error(`DNS challenge solver failed: ${err.message}`);
          throw err;
        }
      },
      {
        maxRetries: 3,
        initialDelay: 5000,
        onRetry: (err, attempt) => {
          logger.warn(
            `Retry ${attempt} setting DNS challenge (${err.message})`
          );
        },
      }
    );
  }

  /**
   * DNS challenge cleaner for ACME
   */
  async _dnsChallengeRemover(authz, _challenge) {
    const recordName = `_acme-challenge.${authz.identifier.value}`;
    await this._removeDnsRecord(recordName);
  }

  /**
   * Issue Let's Encrypt wildcard certificates for domain
   */
  async issueCertificates() {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      logger.info(
        `Obtaining Let's Encrypt wildcard certificate for ${this.mongoDomain}...`
      );

      // Create ACME client
      const client = await this._createClient();

      // Create certificate signing request (CSR)
      const [key, csr] = await acme.forge.createCsr({
        commonName: this.mongoDomain,
        altNames: [`*.${this.mongoDomain}`],
      });

      // Get certificate by solving DNS challenges
      const cert = await client.auto({
        csr,
        email: this.letsencryptEmail,
        termsOfServiceAgreed: true,
        challengePriority: ["dns-01"],
        challengeCreateFn: (authz, challenge, keyAuthorization) =>
          this._dnsChallengeSolver(authz, challenge, keyAuthorization),
        challengeRemoveFn: (authz, challenge) =>
          this._dnsChallengeRemover(authz),
      });

      // Store certificates
      const fullchainPath = path.join(
        this.certbotDir,
        "live",
        this.mongoDomain,
        "fullchain.pem"
      );
      const privkeyPath = path.join(
        this.certbotDir,
        "live",
        this.mongoDomain,
        "privkey.pem"
      );
      const pemBundlePath = path.join(this.certsDir, "fullchain.pem");
      const mongodbPemPath = path.join(this.certsDir, "mongodb.pem");

      // Save certificates
      await fs.writeFile(fullchainPath, cert);
      await fs.writeFile(privkeyPath, key.toString());

      // Create PEM bundle for HAProxy (fullchain + privkey)
      const pemBundle = cert + key.toString();
      await fs.writeFile(pemBundlePath, pemBundle);
      await fs.writeFile(mongodbPemPath, pemBundle);

      // Set proper permissions
      await fs.chmod(privkeyPath, 0o600);
      await fs.chmod(pemBundlePath, 0o600);
      await fs.chmod(mongodbPemPath, 0o600);

      logger.info("Let's Encrypt certificates obtained and saved successfully");
      return {
        success: true,
        domain: this.mongoDomain,
        wildcard: `*.${this.mongoDomain}`,
        fullchainPath,
        privkeyPath,
        pemBundlePath,
        mongodbPemPath,
      };
    } catch (err) {
      logger.error(
        `Failed to obtain Let's Encrypt certificates: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
        }
      );
      throw new AppError(`Failed to obtain certificates: ${err.message}`, 500);
    }
  }

  /**
   * Check if certificates need renewal (expires in less than 30 days)
   */
  async needsRenewal() {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const fullchainPath = path.join(
        this.certbotDir,
        "live",
        this.mongoDomain,
        "fullchain.pem"
      );

      try {
        // Read certificate
        const certData = await fs.readFile(fullchainPath, "utf8");

        // Parse certificate to get expiration date
        const cert = new acme.forge.X509Certificate(certData);
        const expiresAt = new Date(cert.validTo);

        // Calculate days until expiration
        const now = new Date();
        const daysRemaining = Math.floor(
          (expiresAt - now) / (1000 * 60 * 60 * 24)
        );

        logger.info(`Certificate expires in ${daysRemaining} days`);

        // Return true if less than 30 days remaining
        return daysRemaining < 30;
      } catch {
        // If certificate doesn't exist or can't be read, renewal is needed
        logger.info("Certificate not found or invalid, renewal needed");
        return true;
      }
    } catch (err) {
      logger.error(`Failed to check certificate renewal: ${err.message}`);
      // If check fails, assume renewal is needed
      return true;
    }
  }

  /**
   * Renew certificates if needed
   */
  async renewIfNeeded() {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const needsRenewal = await this.needsRenewal();

      if (needsRenewal) {
        logger.info("Certificate renewal needed, obtaining new certificates");
        return await this.issueCertificates();
      } else {
        logger.info("Certificates are still valid, no renewal needed");
        return {
          success: true,
          renewed: false,
          message: "Certificates are still valid",
        };
      }
    } catch (err) {
      logger.error(`Certificate renewal failed: ${err.message}`);
      throw new AppError(`Certificate renewal failed: ${err.message}`, 500);
    }
  }

  /**
   * Set up automated renewal checks
   * @param {number} intervalHours - Interval in hours between checks (default: 24)
   */
  setupAutoRenewal(intervalHours = 24) {
    const intervalMs = intervalHours * 60 * 60 * 1000;

    // Check initially after 1 minute
    setTimeout(() => {
      this.renewIfNeeded().catch((err) => {
        logger.error(`Auto-renewal check failed: ${err.message}`);
      });

      // Then set up recurring checks
      setInterval(() => {
        this.renewIfNeeded().catch((err) => {
          logger.error(`Auto-renewal check failed: ${err.message}`);
        });
      }, intervalMs);
    }, 60000);

    logger.info(
      `Automated certificate renewal checks set up (every ${intervalHours} hours)`
    );
  }
}

module.exports = LetsEncryptManager;
