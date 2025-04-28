/**
 * Certificate Service
 *
 * Unified service that handles all certificate operations including:
 * - Certificate generation, storage, and distribution
 * - Circuit breaking to prevent cascading failures
 * - Monitoring for certificate health and expiration
 * - Automatic certificate renewal scheduling
 * - Advanced error handling and resilience
 */

const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");
const logger = require("../../utils/logger").getLogger("certificateService");
const { promisify } = require("util");
const execAsync = promisify(execSync);
const pathManager = require("../../utils/pathManager");
const axios = require("axios");
const { AppError } = require("../../utils/errorHandler");
const FileLock = require("../../utils/fileLock");
const retryHandler = require("../../utils/retryHandler");
const CertificateProviderFactory = require("../../utils/certProviders/providerFactory");
const EventEmitter = require("events");
const CertificateCircuitBreaker = require("../../utils/certificateCircuitBreaker");
const CertificateMonitor = require("../../utils/certificateMonitor");

// Constants
const CERTIFICATE_LOCK_PREFIX = "cert";
const TRAEFIK_RELOAD_LOCK = "traefik_reload";
const CERTIFICATE_LIST_LOCK = "certificate_list";
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

class CertificateService extends EventEmitter {
  constructor() {
    super(); // Initialize EventEmitter

    this.initialized = false;
    this.certsDir = null;
    this.caCertPath = null;
    this.caKeyPath = null;
    this.mongoDomain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";

    // Single source of truth for agent certificates
    this.agentCertsBaseDir = null;

    // Consistent path structure for all certificate files
    this.certificatePathStructure = {
      agentKey: "server.key", // Private key
      agentCert: "server.crt", // Certificate
      agentPem: "server.pem", // Combined PEM
      haproxyCert: "haproxy.pem", // HAProxy format
      traefikCert: "traefik.pem", // Traefik format
    };

    // Fallback base for writable certs when config mounts are read-only
    this.localCertsDir =
      process.env.LOCAL_CERTS_BASE_PATH ||
      path.join(os.tmpdir(), "cloudlunacy-certs");
    fs.mkdir(this.localCertsDir, { recursive: true }).catch(() => {});

    // Local CA certificate paths for fallback
    this.localCaCertPath = path.join(this.localCertsDir, "ca.crt");
    this.localCaKeyPath = path.join(this.localCertsDir, "ca.key");

    // Traefik API configuration (if available)
    this.traefikApiUrl =
      process.env.TRAEFIK_API_URL || "http://localhost:8080/api";

    // Initialize certificate provider using factory
    const providerType = process.env.CERT_PROVIDER_TYPE || "self-signed";
    this.provider = this._createProvider(providerType);

    // Enhanced features from EnhancedCertificateManager

    // Default renewal settings
    this.defaultRenewalDays = parseInt(process.env.CERT_RENEWAL_DAYS, 10) || 30;
    this.renewalScheduleInterval =
      parseInt(process.env.CERT_CHECK_INTERVAL_MS, 10) || 24 * 60 * 60 * 1000; // 24 hours

    // Create circuit breaker for resilient certificate operations
    this.circuitBreaker = new CertificateCircuitBreaker({
      failureThreshold: parseInt(process.env.CERT_FAILURE_THRESHOLD, 10) || 5,
      resetTimeout:
        parseInt(process.env.CERT_RESET_TIMEOUT_MS, 10) || 5 * 60 * 1000, // 5 minutes
      healthCheck: async () => this._checkCertificateSystemHealth(),
    });

    // Store retry configuration for handling transient failures
    this.retryConfig = {
      maxRetries: parseInt(process.env.CERT_RETRY_COUNT, 10) || 3,
      initialDelay: parseInt(process.env.CERT_RETRY_DELAY_MS, 10) || 1000,
      maxDelay: parseInt(process.env.CERT_MAX_RETRY_DELAY_MS, 10) || 30000,
      backoffFactor: parseFloat(process.env.CERT_BACKOFF_FACTOR) || 2,
    };

    // Setup certificate monitoring
    this.certificateMonitor = new CertificateMonitor({
      certificatesPath: this.certsPath,
      getActiveCertificates: () => this.getActiveCertificates(),
      checkInterval:
        parseInt(process.env.CERT_MONITOR_INTERVAL_MS, 10) || 60 * 60 * 1000, // 1 hour
      warningThresholdDays:
        parseInt(process.env.CERT_WARNING_THRESHOLD_DAYS, 10) || 14,
      criticalThresholdDays:
        parseInt(process.env.CERT_CRITICAL_THRESHOLD_DAYS, 10) || 3,
    });

    // Setup certificate renewal scheduling
    this.renewalSchedule = [];
    this.renewalTimer = null;

    // Forward certificate monitor events
    this._setupEventListeners();
  }

  /**
   * Create and configure a certificate provider
   * @private
   */
  _createProvider(type) {
    try {
      // Create provider config based on environment variables and defaults
      const providerConfig = {
        certsDir: this.certsDir,
        caCertPath: this.caCertPath,
        caKeyPath: this.caKeyPath,
        validityDays: parseInt(process.env.CERT_VALIDITY_DAYS, 10) || 365,
        // ACME-specific options
        accountEmail: process.env.ACME_ACCOUNT_EMAIL,
        acmeServer: process.env.ACME_SERVER,
        acmeStaging: process.env.ACME_STAGING === "true",
        challengeType: process.env.ACME_CHALLENGE_TYPE || "http",
        webRootPath: process.env.ACME_WEBROOT_PATH,
        dnsProvider: process.env.ACME_DNS_PROVIDER,
        dnsCredentials: this._parseDnsCredentials(
          process.env.ACME_DNS_CREDENTIALS
        ),
      };

      return CertificateProviderFactory.createProvider(type, providerConfig);
    } catch (err) {
      logger.error(`Failed to create certificate provider: ${err.message}`);
      throw err;
    }
  }

  /**
   * Parse DNS credentials from environment variable
   * @private
   */
  _parseDnsCredentials(credentialsString) {
    if (!credentialsString) {
      return {};
    }

    try {
      return JSON.parse(credentialsString);
    } catch (err) {
      logger.error(`Failed to parse DNS credentials: ${err.message}`);
      return {};
    }
  }

  /**
   * Initialize the certificate service
   */
  async initialize() {
    logger.info("Initializing unified certificate service");

    try {
      // Initialize path manager if needed
      if (!pathManager.initialized) {
        await pathManager.initialize();
      }

      // Set paths from path manager
      this.certsDir = pathManager.getPath("certs");
      this.caCertPath = pathManager.getPath("caCert");
      this.caKeyPath = pathManager.getPath("caKey");

      // Set single source of truth for agent certificates
      this.agentCertsBaseDir = path.join(this.certsDir, "agents");

      // Update certificate monitor path
      this.certificateMonitor.certificatesPath = this.certsDir;

      // Ensure certificates directory exists
      await this._ensureCertsDir();

      // Ensure CA certificate exists
      await this._ensureCA();

      // Initialize the certificate provider
      try {
        // Update provider with correct paths
        this.provider.updateConfig({
          certsDir: this.certsDir,
          caCertPath: this.caCertPath,
          caKeyPath: this.caKeyPath,
        });

        await this.provider.initialize();
        logger.info("Certificate provider initialized successfully");
      } catch (providerErr) {
        logger.warn(
          `Certificate provider initialization warning: ${providerErr.message}`
        );
        // Continue even if provider initialization fails, as we can still use basic operations
      }

      // Start monitoring and health checks
      await this.certificateMonitor.start();
      this.circuitBreaker.startHealthChecks();

      // Schedule certificate renewals
      await this._scheduleRenewals();

      this.initialized = true;
      logger.info("Unified certificate service initialized successfully");
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
   * Create certificate for an agent
   * @param {string} agentId - Agent ID
   * @param {string} targetIp - Target IP address
   * @returns {Promise<Object>} Result with certificate paths
   */
  async createCertificateForAgent(agentId, targetIp) {
    // Create a resource-specific lock ID
    const lockId = `${CERTIFICATE_LOCK_PREFIX}_${agentId}`;

    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info(
        `Requesting certificate generation lock for agent ${agentId}`
      );

      // Acquire lock to prevent race conditions with parallel certificate operations
      return await FileLock.withLock(
        lockId,
        async () => {
          logger.info(`Creating certificate for agent ${agentId}`);

          // Determine writable agent certificate directory (fall back if bind mount is read-only)
          let agentCertDir = path.join(this.certsDir, "agents", agentId);
          await fs.mkdir(agentCertDir, { recursive: true });
          // Test writability
          let writable = true;
          try {
            await fs.access(agentCertDir, fsSync.constants.W_OK);
          } catch {
            writable = false;
          }
          if (!writable) {
            logger.warn(
              `Agent cert dir ${agentCertDir} not writable, using local fallback`
            );
            agentCertDir = path.join(this.localCertsDir, agentId);
            await fs.mkdir(agentCertDir, { recursive: true });
          }
          // Ensure directory permissions where possible
          try {
            await fs.chmod(agentCertDir, 0o755);
          } catch (chmodErr) {
            logger.warn(
              `Could not set permissions for agent cert directory: ${chmodErr.message}`
            );
          }
          logger.info(`Using agent cert directory: ${agentCertDir}`);

          // Define paths
          const keyPath = path.join(agentCertDir, "server.key");
          const csrPath = path.join(agentCertDir, "server.csr");
          const certPath = path.join(agentCertDir, "server.crt");
          const pemPath = path.join(agentCertDir, "server.pem");
          const tempKeyPath = path.join(agentCertDir, ".server.key.tmp");
          const tempCertPath = path.join(agentCertDir, ".server.crt.tmp");
          const tempPemPath = path.join(agentCertDir, ".server.pem.tmp");
          const configPath = path.join(os.tmpdir(), `openssl_${agentId}.cnf`);
          const mongoSubdomain = `${agentId}.${this.mongoDomain}`;

          // Validate IP address to prevent OpenSSL errors
          const isValidIP = (ip) => {
            if (!ip || typeof ip !== "string") return false;

            // IPv4 validation
            const ipv4Regex =
              /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
            return ipv4Regex.test(ip);
          };

          // Create OpenSSL configuration with comprehensive key usage settings for broad client compatibility
          let opensslConfig = `
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = ${mongoSubdomain}

[v3_req]
# Enhanced key usage settings for MongoDB Compass and other strict clients
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment, nonRepudiation, dataEncipherment, keyAgreement
extendedKeyUsage = serverAuth, clientAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = ${mongoSubdomain}
DNS.2 = localhost
`;

          // Add IP address if valid
          if (isValidIP(targetIp)) {
            opensslConfig += `IP.1 = ${targetIp}\n`;
          }
          opensslConfig += `IP.2 = 127.0.0.1\n`;

          // Write OpenSSL configuration
          await fs.writeFile(configPath, opensslConfig);

          // Ensure CA key and certificate are accessible
          // If originals can't be accessed, attempt to use fallback copies
          let effectiveCaCertPath = this.caCertPath;
          let effectiveCaKeyPath = this.caKeyPath;

          // First check if we have existing local copies of CA files
          let localCopiesExist = false;
          try {
            await fs.access(this.localCaCertPath, fsSync.constants.R_OK);
            await fs.access(this.localCaKeyPath, fsSync.constants.R_OK);
            localCopiesExist = true;
          } catch (accessErr) {
            localCopiesExist = false;
          }

          // Then check if the original CA files are accessible
          let originalFilesAccessible = true;
          try {
            await fs.access(this.caCertPath, fsSync.constants.R_OK);
            await fs.access(this.caKeyPath, fsSync.constants.R_OK);
          } catch (accessErr) {
            originalFilesAccessible = false;
          }

          // If we can access originals but don't have local copies, create them
          if (originalFilesAccessible && !localCopiesExist) {
            try {
              // Copy to local fallback location
              await fs.copyFile(this.caCertPath, this.localCaCertPath);
              await fs.copyFile(this.caKeyPath, this.localCaKeyPath);
              await fs.chmod(this.localCaCertPath, 0o644);
              await fs.chmod(this.localCaKeyPath, 0o600);
              logger.info(
                "Copied CA files to fallback location for future use"
              );
            } catch (copyErr) {
              logger.warn(
                `Failed to create fallback copies of CA files: ${copyErr.message}`
              );
            }
          }

          // If original CA files aren't accessible but we have local copies, use those
          if (!originalFilesAccessible && localCopiesExist) {
            logger.info(
              "Using local fallback copies of CA files due to permission issues"
            );
            effectiveCaCertPath = this.localCaCertPath;
            effectiveCaKeyPath = this.localCaKeyPath;
          }

          // If neither originals nor local copies are accessible, try to create new ones
          if (!originalFilesAccessible && !localCopiesExist) {
            try {
              logger.warn(
                "Cannot access CA files, creating temporary CA certificates"
              );

              // Generate a temporary CA key and certificate
              await fs.mkdir(path.dirname(this.localCaKeyPath), {
                recursive: true,
              });

              // Generate CA private key
              execSync(`openssl genrsa -out ${this.localCaKeyPath} 2048`);

              // Generate CA certificate
              execSync(
                `openssl req -x509 -new -nodes -key ${this.localCaKeyPath} -sha256 -days 3650 -out ${this.localCaCertPath} -subj "/CN=CloudLunacy Temp CA/O=CloudLunacy/C=UK"`
              );

              // Set proper permissions
              await fs.chmod(this.localCaKeyPath, 0o600);
              await fs.chmod(this.localCaCertPath, 0o644);

              logger.info(
                "Temporary CA certificate and key generated successfully"
              );

              // Use the temporary CA files for certificate generation
              effectiveCaCertPath = this.localCaCertPath;
              effectiveCaKeyPath = this.localCaKeyPath;
              localCopiesExist = true;
            } catch (genErr) {
              logger.error(
                `Failed to generate temporary CA: ${genErr.message}`
              );
              throw new Error(
                "Cannot access CA files and failed to create temporary CA"
              );
            }
          }

          // If we still don't have usable CA files, throw error
          if (!originalFilesAccessible && !localCopiesExist) {
            throw new Error(
              "Cannot access CA files and no fallback copies exist"
            );
          }

          try {
            // Generate private key to temporary file first
            execSync(`openssl genrsa -out ${tempKeyPath} 2048`);

            // Generate CSR
            execSync(
              `openssl req -new -key ${tempKeyPath} -out ${csrPath} -config ${configPath}`
            );

            // Sign certificate with CA
            // Determine CA serial option: fallback to local serial file if certsDir is read-only
            let caSerialOption = "-CAcreateserial";
            if (agentCertDir.startsWith(this.localCertsDir)) {
              const localSerial = path.join(this.localCertsDir, "ca.srl");
              try {
                await fs.access(localSerial);
              } catch {
                await fs.writeFile(localSerial, "01");
              }
              caSerialOption = `-CAserial ${localSerial}`;
            }
            execSync(
              `openssl x509 -req -in ${csrPath} -CA ${effectiveCaCertPath} -CAkey ${effectiveCaKeyPath} ${caSerialOption} -out ${tempCertPath} -days 365 -extensions v3_req -extfile ${configPath}`
            );

            // Create combined PEM file
            const certContent = await fs.readFile(tempCertPath, "utf8");
            const keyContent = await fs.readFile(tempKeyPath, "utf8");
            const pemContent = certContent + keyContent;
            await fs.writeFile(tempPemPath, pemContent);

            // Set permissions
            await fs.chmod(tempKeyPath, 0o600);
            await fs.chmod(tempCertPath, 0o644);
            await fs.chmod(tempPemPath, 0o600);

            // Atomically move temporary files to final locations
            await fs.rename(tempKeyPath, keyPath);
            await fs.rename(tempCertPath, certPath);
            await fs.rename(tempPemPath, pemPath);

            // Certificate created successfully
            logger.info(`Certificate created for agent ${agentId}`);
            return {
              success: true,
              keyPath,
              certPath,
              pemPath,
              caPath: this.caCertPath,
            };
          } catch (err) {
            // Clean up temporary files if they exist
            try {
              await fs.unlink(tempKeyPath).catch(() => {});
              await fs.unlink(tempCertPath).catch(() => {});
              await fs.unlink(tempPemPath).catch(() => {});
            } catch (cleanupErr) {
              logger.warn(
                `Failed to clean up temporary files: ${cleanupErr.message}`
              );
            }
            throw err;
          }
        },
        60000 // Increased from 15000 to 60000 (60 seconds) to accommodate slower systems
      );
    } catch (err) {
      if (err.message.includes("Could not acquire lock")) {
        logger.error(
          `Lock acquisition timeout for agent ${agentId} certificate generation`
        );
        return {
          success: false,
          error: `Certificate generation already in progress for agent ${agentId}. Try again later.`,
          transient: true,
        };
      }

      logger.error(
        `Failed to create certificate for agent ${agentId}: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
        }
      );

      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Alias for createCertificateForAgent to maintain API compatibility
   * @param {string} agentId - Agent ID
   * @param {string} targetIp - Target IP address
   * @returns {Promise<Object>} Result with certificate paths and contents
   */
  async generateAgentCertificate(agentId, targetIp) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      // Create certificates first
      const result = await this.createCertificateForAgent(agentId, targetIp);

      if (!result.success) {
        return result;
      }

      // Read content of cert files to include in response
      const caCert = await fs.readFile(this.caCertPath, "utf8");
      const serverCert = await fs.readFile(result.certPath, "utf8");
      const serverKey = await fs.readFile(result.keyPath, "utf8");

      return {
        success: true,
        agentId,
        keyPath: result.keyPath,
        certPath: result.certPath,
        pemPath: result.pemPath,
        caPath: this.caCertPath,
        caCert,
        serverCert,
        serverKey,
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
   * Get agent certificates with consolidated approach
   * @param {string} agentId - Agent ID
   * @returns {Promise<Object>} Certificate files and paths
   */
  async getAgentCertificates(agentId) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      // Use the single source of truth for agent certificates
      const agentCertDir = path.join(this.agentCertsBaseDir, agentId);
      const keyPath = path.join(
        agentCertDir,
        this.certificatePathStructure.agentKey
      );
      const certPath = path.join(
        agentCertDir,
        this.certificatePathStructure.agentCert
      );
      const pemPath = path.join(
        agentCertDir,
        this.certificatePathStructure.agentPem
      );

      // Check if certificate exists
      try {
        await fs.access(certPath);
        await fs.access(keyPath);
      } catch (err) {
        logger.warn(
          `Certificates for agent ${agentId} not found in primary location: ${err.message}`
        );

        // Try fallback location if exists
        const fallbackDir = path.join(this.localCertsDir, agentId);
        const fallbackKeyPath = path.join(
          fallbackDir,
          this.certificatePathStructure.agentKey
        );
        const fallbackCertPath = path.join(
          fallbackDir,
          this.certificatePathStructure.agentCert
        );

        try {
          await fs.access(fallbackCertPath);
          await fs.access(fallbackKeyPath);

          // Found in fallback location
          logger.info(
            `Found certificates for agent ${agentId} in fallback location`
          );

          // Read certificate files from fallback location
          const serverCert = await fs.readFile(fallbackCertPath, "utf8");
          const serverKey = await fs.readFile(fallbackKeyPath, "utf8");
          const caCert = await fs.readFile(this.caCertPath, "utf8");

          return {
            agentId,
            domain: `${agentId}.${this.mongoDomain}`,
            serverKey,
            serverCert,
            caCert,
            keyPath: fallbackKeyPath,
            certPath: fallbackCertPath,
            caPath: this.caCertPath,
            usedFallback: true,
          };
        } catch (fallbackErr) {
          // Not found in fallback location either
          logger.error(
            `Certificates not found for agent ${agentId} in any location`
          );
          return {
            success: false,
            error: `Certificates for agent ${agentId} not found`,
          };
        }
      }

      // Read certificate files from primary location
      const serverCert = await fs.readFile(certPath, "utf8");
      const serverKey = await fs.readFile(keyPath, "utf8");
      const caCert = await fs.readFile(this.caCertPath, "utf8");

      return {
        agentId,
        domain: `${agentId}.${this.mongoDomain}`,
        serverKey,
        serverCert,
        caCert,
        keyPath,
        certPath,
        caPath: this.caCertPath,
        pemPath,
        usedFallback: false,
      };
    } catch (err) {
      logger.error(
        `Failed to get agent certificates for ${agentId}: ${err.message}`
      );
      throw err;
    }
  }

  /**
   * Reload Traefik to apply certificate changes
   * @returns {Promise<Object>} Result of the operation
   */
  async reloadTraefik() {
    let lock = null;
    // Use lock to prevent multiple simultaneous reloads
    try {
      lock = await FileLock.acquire(TRAEFIK_RELOAD_LOCK, 10000);

      if (!lock.success) {
        logger.info(
          "Traefik reload already in progress, skipping duplicate reload"
        );
        return {
          success: true,
          message: "Traefik reload already in progress by another process",
        };
      }

      try {
        logger.info("Reloading Traefik to apply certificate changes");

        // Create a function to retry with both methods
        const reloadWithRetries = async () => {
          // First try using Docker command
          try {
            const traefikContainer = process.env.TRAEFIK_CONTAINER || "traefik";
            const execTimeout = 15000; // 15-second timeout for Docker commands

            // Validate Traefik configuration before reloading
            try {
              await Promise.race([
                execAsync(
                  `docker exec ${traefikContainer} traefik validate --check-config`
                ),
                new Promise((_, reject) =>
                  setTimeout(
                    () =>
                      reject(
                        new Error(
                          "Docker exec command timed out after 15 seconds"
                        )
                      ),
                    execTimeout
                  )
                ),
              ]);

              logger.info("Traefik configuration validated successfully");
            } catch (validationErr) {
              logger.error(
                `Traefik configuration validation failed: ${validationErr.message}`
              );
              throw new Error(
                `Invalid Traefik configuration: ${validationErr.message}`
              );
            }

            // Restart Traefik container
            await Promise.race([
              execAsync(`docker restart ${traefikContainer}`),
              new Promise((_, reject) =>
                setTimeout(
                  () =>
                    reject(
                      new Error(
                        "Traefik restart command timed out after 15 seconds"
                      )
                    ),
                  execTimeout
                )
              ),
            ]);

            // Verify that Traefik is still running after restart with timeout
            const { stdout } = await Promise.race([
              execAsync(`docker ps -q -f name=${traefikContainer}`),
              new Promise((_, reject) =>
                setTimeout(
                  () =>
                    reject(
                      new Error("Docker ps command timed out after 15 seconds")
                    ),
                  execTimeout
                )
              ),
            ]);

            if (!stdout.trim()) {
              throw new Error("Traefik is not running after restart attempt");
            }

            logger.info("Traefik reloaded successfully via Docker command");
            return { success: true, message: "Traefik reloaded successfully" };
          } catch (dockerErr) {
            logger.warn(
              `Failed to reload Traefik via Docker: ${dockerErr.message}`
            );

            // Fallback to API call
            try {
              // Unlike HAProxy Data Plane API, Traefik API doesn't have a specific reload endpoint
              // Instead, we'll check the health of the Traefik API to confirm it's running
              const response = await axios.get(this.traefikApiUrl, {
                timeout: 5000,
              });

              if (response.status >= 200 && response.status < 300) {
                logger.info("Traefik API is responsive after restart attempt");
                return {
                  success: true,
                  message:
                    "Traefik appears to be running after restart attempt",
                };
              } else {
                throw new Error(`Unexpected status code: ${response.status}`);
              }
            } catch (apiErr) {
              logger.error(
                `Failed to verify Traefik via API: ${apiErr.message}`
              );
              throw apiErr;
            }
          }
        };

        // Use the retry handler to retry the reload operation
        return await retryHandler.withRetry(reloadWithRetries, {
          maxRetries: MAX_RETRY_ATTEMPTS,
          initialDelay: RETRY_DELAY_MS,
          onRetry: (error, attempt) => {
            logger.warn(
              `Retry ${attempt}/${MAX_RETRY_ATTEMPTS} reloading Traefik: ${error.message}`
            );
          },
        });
      } finally {
        // Always release the lock when done, but check if it exists and has release method first
        if (lock && typeof lock.release === "function") {
          await lock.release();
        }
      }
    } catch (err) {
      logger.error(`Failed to reload Traefik: ${err.message}`);
      // Final attempt to release the lock if it exists
      if (lock && typeof lock.release === "function") {
        try {
          await lock.release();
        } catch (releaseErr) {
          logger.warn(
            `Failed to release Traefik reload lock: ${releaseErr.message}`
          );
        }
      }
      return { success: false, error: err.message };
    }
  }

  /**
   * Ensure a minimal valid certificate exists for HAProxy to start
   * This creates a self-signed certificate if no certificate exists yet
   * @returns {Promise<boolean>} Success status
   */
  async ensureMinimalCertificate() {
    try {
      // Use the host path instead of the container path
      const hostCertsDir = this.certsDir; // This is /opt/cloudlunacy_front/config/certs
      const singleCertPath = path.join(hostCertsDir, "mongodb.pem");

      try {
        // Check if certificate already exists
        await fs.access(singleCertPath);
        logger.debug("MongoDB certificate already exists at host path");
        return true;
      } catch {
        // Certificate doesn't exist, create a minimal self-signed one
        logger.info("Creating placeholder certificate for HAProxy startup");

        const tempDir = "/tmp/cloudlunacy-certs";
        await fs.mkdir(tempDir, { recursive: true });

        const keyPath = path.join(tempDir, "placeholder.key");
        const certPath = path.join(tempDir, "placeholder.crt");
        const pemPath = path.join(tempDir, "placeholder.pem");

        // Generate a self-signed certificate
        try {
          // Create private key
          execSync(`openssl genrsa -out ${keyPath} 2048`);

          // Create certificate
          execSync(
            `openssl req -new -x509 -key ${keyPath} -out ${certPath} -days 3650 -subj "/CN=placeholder.${this.mongoDomain}" -nodes`
          );

          // Combine into PEM file
          const certContent = await fs.readFile(certPath, "utf8");
          const keyContent = await fs.readFile(keyPath, "utf8");
          const pemContent = certContent + keyContent;
          await fs.writeFile(pemPath, pemContent);

          // Copy to HOST certificate location, not the container
          await fs.copyFile(pemPath, singleCertPath);
          await fs.chmod(singleCertPath, 0o600);

          logger.info(
            "Created placeholder certificate for HAProxy at host path"
          );

          // Clean up temp files
          await fs.unlink(keyPath);
          await fs.unlink(certPath);
          await fs.unlink(pemPath);

          return true;
        } catch (genErr) {
          logger.error(
            `Failed to generate placeholder certificate: ${genErr.message}`
          );

          // As a fallback, create an empty file
          logger.warn(
            "Creating empty certificate file as last resort at host path"
          );
          await fs.writeFile(singleCertPath, "");
          await fs.chmod(singleCertPath, 0o600);

          return false;
        }
      }
    } catch (_) {
      logger.error("Failed to ensure minimal certificate");
      return false;
    }
  }

  /**
   * Update certificates in Traefik
   * @param {string} agentId - The agent ID
   * @param {string} certPath - Path to the certificate file
   * @param {string} keyPath - Path to the key file
   * @param {string} pemPath - Path to the combined PEM file
   * @returns {Promise<Object>} Result of the update
   */
  async updateTraefikCertificates(agentId, certPath, keyPath, pemPath) {
    // Use a lock to prevent concurrent updates to the certificate files
    const certificateListLock = `${CERTIFICATE_LIST_LOCK}`;

    try {
      logger.info(`Updating Traefik certificates for agent ${agentId}`);

      // Ensure certificates directory exists
      const traefikCertsDir = path.join(this.certsDir, "traefik");
      const tempPemPath = path.join(traefikCertsDir, `.${agentId}.temp.pem`);
      const agentPemPath = path.join(traefikCertsDir, `${agentId}.pem`);

      try {
        // Create directories if they don't exist
        await fs.mkdir(traefikCertsDir, { recursive: true });

        // Create a temporary file first, then move atomically to avoid race conditions
        await fs.copyFile(pemPath, tempPemPath);
        await fs.chmod(tempPemPath, 0o600);

        // This is a critical section that modifies shared resources - use lock
        return await FileLock.withLock(
          certificateListLock,
          async () => {
            // Move the temporary file to the final location atomically
            await fs.rename(tempPemPath, agentPemPath);
            logger.info(
              `Updated certificate at ${agentPemPath} for agent ${agentId}`
            );

            // Reload Traefik to apply certificate changes
            const reloadResult = await this.reloadTraefik();

            return {
              success: reloadResult.success,
              reloadResult,
              message: `Certificate updates applied for agent ${agentId}`,
            };
          },
          30000 // 30 second timeout for the lock
        );
      } catch (copyErr) {
        // Clean up temporary file if it exists
        try {
          await fs.unlink(tempPemPath).catch(() => {});
        } catch (cleanupErr) {
          logger.debug(`Failed to clean up temp file: ${cleanupErr.message}`);
        }

        logger.warn(
          `Failed to copy certificates to Traefik locations: ${copyErr.message}`
        );
        return {
          success: false,
          error: copyErr.message,
        };
      }
    } catch (err) {
      if (err.message.includes("Could not acquire lock")) {
        logger.warn(
          `Certificate list is being updated by another process. Will retry later for agent ${agentId}`
        );
        return {
          success: false,
          error: "Certificate system is busy. Please try again shortly.",
          transient: true,
        };
      }

      logger.error(`Failed to update Traefik certificates: ${err.message}`);
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

  /**
   * Validate an agent's certificate and HAProxy configuration
   * @param {string} agentId - Agent ID
   * @returns {Promise<Object>} Validation results
   */
  async validateCertificateSetup(agentId) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info(`Validating certificate setup for agent ${agentId}`);

      const results = {
        success: true,
        agentId,
        certificate: { valid: false },
        haproxy: { valid: false },
        issues: [],
      };

      // 1. Check if certificate exists and is valid
      try {
        const certInfo = await this.getCertificateInfo(agentId);

        if (!certInfo.exists) {
          results.certificate.valid = false;
          results.certificate.exists = false;
          results.issues.push(
            `Certificate for agent ${agentId} does not exist`
          );
        } else if (certInfo.isExpired) {
          results.certificate.valid = false;
          results.certificate.exists = true;
          results.certificate.expired = true;
          results.certificate.daysRemaining = certInfo.daysRemaining;
          results.issues.push(`Certificate for agent ${agentId} is expired`);
        } else {
          results.certificate.valid = true;
          results.certificate.exists = true;
          results.certificate.expired = false;
          results.certificate.daysRemaining = certInfo.daysRemaining;
        }
      } catch (certErr) {
        results.certificate.valid = false;
        results.certificate.error = certErr.message;
        results.issues.push(
          `Failed to validate certificate: ${certErr.message}`
        );
      }

      // 2. Check if certificate is properly configured in HAProxy
      try {
        // First try single certificate approach
        const singleCertPath = path.join(this.certsDir, "mongodb.pem");
        let singleCertExists = false;

        try {
          await fs.access(singleCertPath);
          singleCertExists = true;
          results.haproxy.singleCertExists = true;
        } catch (accessErr) {
          results.haproxy.singleCertExists = false;
          results.issues.push("Single certificate file not found");
        }

        // Then check multi-certificate approach
        const certsDir = path.join(this.certsDir, "mongodb");
        const agentPemPath = path.join(certsDir, `${agentId}.pem`);
        let agentCertExists = false;

        try {
          await fs.access(agentPemPath);
          agentCertExists = true;
          results.haproxy.agentCertExists = true;
        } catch (accessErr) {
          results.haproxy.agentCertExists = false;
          results.issues.push(
            `Agent-specific certificate not found in multi-cert directory`
          );
        }

        // Check certificate list
        const certListPath = path.join(this.certsDir, "mongodb-certs.list");
        try {
          const certListContent = await fs.readFile(certListPath, "utf-8");
          const entryPattern = new RegExp(
            `\\S+\\s+${agentId}\\.${this.mongoDomain}`
          );
          results.haproxy.inCertList = entryPattern.test(certListContent);

          if (!results.haproxy.inCertList) {
            results.issues.push(
              `Agent ${agentId} not found in certificate list`
            );
          }
        } catch (listErr) {
          results.haproxy.certListExists = false;
          results.issues.push("Certificate list file not found");
        }

        // Verify HAProxy configuration via API
        try {
          const client = this._getApiClient();
          const backendName = `${agentId}-mongodb-backend`;

          try {
            await client.get(
              `/services/haproxy/configuration/backends/${backendName}`
            );
            results.haproxy.backendExists = true;
          } catch (backendErr) {
            if (backendErr.response && backendErr.response.status === 404) {
              results.haproxy.backendExists = false;
              results.issues.push(`HAProxy backend ${backendName} not found`);
            } else {
              throw backendErr;
            }
          }

          // Check for certificate store
          const certStoreName = `mongodb_${agentId}_certs`;
          try {
            await client.get(
              `/services/haproxy/configuration/certificate_stores/${certStoreName}`
            );
            results.haproxy.certStoreExists = true;
          } catch (storeErr) {
            if (storeErr.response && storeErr.response.status === 404) {
              results.haproxy.certStoreExists = false;
              results.issues.push(
                `HAProxy certificate store ${certStoreName} not found`
              );
            } else {
              throw storeErr;
            }
          }

          // Set overall HAProxy validity
          results.haproxy.valid =
            (singleCertExists || agentCertExists) &&
            results.haproxy.backendExists;
        } catch (apiErr) {
          results.haproxy.valid = false;
          results.haproxy.apiError = apiErr.message;
          results.issues.push(
            `Failed to validate HAProxy configuration: ${apiErr.message}`
          );
        }
      } catch (haproxyErr) {
        results.haproxy.valid = false;
        results.haproxy.error = haproxyErr.message;
        results.issues.push(`HAProxy validation error: ${haproxyErr.message}`);
      }

      // Set overall success based on certificate and HAProxy validity
      results.success = results.certificate.valid && results.haproxy.valid;

      return results;
    } catch (err) {
      logger.error(
        `Failed to validate certificate setup for agent ${agentId}: ${err.message}`
      );
      return {
        success: false,
        error: err.message,
        issues: [`Validation failed: ${err.message}`],
      };
    }
  }

  /**
   * Check which certificates need renewal and renew them
   * @param {Object} options - Options for certificate renewal
   * @param {number} options.renewBeforeDays - Renew certificates with fewer days remaining (default: 30)
   * @param {boolean} options.forceRenewal - Force renewal of all certificates regardless of expiry (default: false)
   * @returns {Promise<Object>} Result of the certificate renewal operation
   */
  async checkAndRenewCertificates(options = {}) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      const renewBeforeDays = options.renewBeforeDays || 30;
      const forceRenewal = options.forceRenewal || false;

      logger.info(
        `Checking certificates for renewal (renewal threshold: ${renewBeforeDays} days)`
      );

      // Find all agent certificate directories
      const agentsDir = path.join(this.certsDir, "agents");
      let agentDirs;
      try {
        agentDirs = await fs.readdir(agentsDir);
      } catch (err) {
        logger.error(`Failed to read agents directory: ${err.message}`);
        return {
          success: false,
          error: `Failed to read agents directory: ${err.message}`,
        };
      }

      const results = {
        success: true,
        totalChecked: 0,
        renewed: [],
        failed: [],
        skipped: [],
        notFound: [],
      };

      // Check each agent certificate
      for (const agentId of agentDirs) {
        try {
          results.totalChecked++;

          // Get certificate info to check expiry
          const certInfo = await this.getCertificateInfo(agentId);

          // Skip if certificate doesn't exist
          if (!certInfo.exists) {
            logger.warn(`Certificate for agent ${agentId} not found`);
            results.notFound.push({ agentId, reason: "Certificate not found" });
            continue;
          }

          // Get the agent IP from the certificate or use a fallback
          let targetIp = null;
          if (certInfo.summary) {
            // Try to extract IP address from certificate
            const ipMatch = certInfo.summary.match(
              /IP Address:(\d+\.\d+\.\d+\.\d+)/
            );
            if (ipMatch && ipMatch[1]) {
              targetIp = ipMatch[1];
            }
          }

          // Determine if renewal is needed
          const needsRenewal =
            forceRenewal ||
            !certInfo.success ||
            certInfo.isExpired ||
            (certInfo.daysRemaining !== undefined &&
              certInfo.daysRemaining < renewBeforeDays);

          if (needsRenewal) {
            logger.info(
              `Renewing certificate for agent ${agentId} (days remaining: ${
                certInfo.daysRemaining || 0
              })`
            );

            // Use lock to prevent concurrent renewal of the same certificate
            const lockId = `${CERTIFICATE_LOCK_PREFIX}_renewal_${agentId}`;
            const lockResult = await FileLock.acquire(lockId, 5000);

            if (!lockResult.success) {
              logger.warn(
                `Skipping renewal for ${agentId} - another process is already renewing it`
              );
              results.skipped.push({
                agentId,
                reason: "Locked by another process",
              });
              continue;
            }

            try {
              // Perform actual renewal
              const renewalResult = await this.renewCertificate(
                agentId,
                targetIp
              );

              if (renewalResult.success) {
                results.renewed.push({
                  agentId,
                  daysRemaining: certInfo.daysRemaining,
                  newExpiry: await this.getCertificateExpiryDate(agentId),
                });
              } else {
                results.failed.push({
                  agentId,
                  error: renewalResult.error,
                });
              }
            } finally {
              // Always release the lock with proper error handling
              if (
                lockResult &&
                lockResult.lock &&
                typeof lockResult.lock.release === "function"
              ) {
                try {
                  await lockResult.lock.release();
                } catch (releaseErr) {
                  logger.warn(
                    `Failed to release lock for ${agentId}: ${releaseErr.message}`
                  );
                }
              }
            }
          } else {
            // Certificate doesn't need renewal yet
            results.skipped.push({
              agentId,
              reason: `Certificate still valid (${certInfo.daysRemaining} days remaining)`,
            });
          }
        } catch (agentErr) {
          logger.error(
            `Error processing agent ${agentId}: ${agentErr.message}`
          );
          results.failed.push({
            agentId,
            error: agentErr.message,
          });
        }
      }

      // Summarize results
      const summary =
        `Certificate renewal check completed: ${results.renewed.length} renewed, ` +
        `${results.skipped.length} skipped, ${results.failed.length} failed, ` +
        `${results.notFound.length} not found`;
      logger.info(summary);

      results.message = summary;
      return results;
    } catch (err) {
      logger.error(`Failed to check and renew certificates: ${err.message}`);
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Get certificate expiry date
   * @param {string} agentId - Agent ID
   * @returns {Promise<string|null>} - Expiry date in ISO format or null if not found
   */
  async getCertificateExpiryDate(agentId) {
    try {
      const certInfo = await this.getCertificateInfo(agentId);
      return certInfo.expiry;
    } catch (err) {
      logger.error(
        `Failed to get certificate expiry date for ${agentId}: ${err.message}`
      );
      return null;
    }
  }

  /**
   * Get certificate dashboard data including status of all certificates in the system
   * @returns {Promise<Object>} Dashboard data with certificate information
   */
  async getCertificateDashboard() {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info("Generating certificate dashboard data");

      const dashboardData = {
        timestamp: new Date().toISOString(),
        caInfo: await this.getCAInfo(),
        agentCertificates: [],
        metrics: {
          total: 0,
          valid: 0,
          expiring: 0,
          expired: 0,
          missing: 0,
          configIssues: 0,
        },
        systemStatus: {
          haproxyConfigValid: false,
          certListValid: false,
        },
      };

      // Find all agent certificate directories
      const agentsDir = path.join(this.certsDir, "agents");
      let agentDirs;

      try {
        agentDirs = await fs.readdir(agentsDir);
        dashboardData.metrics.total = agentDirs.length;
      } catch (err) {
        logger.error(`Failed to read agents directory: ${err.message}`);
        dashboardData.systemStatus.agentDirError = err.message;
        dashboardData.metrics.total = 0;
        return dashboardData;
      }

      // Check for the certificate list file
      try {
        const certListPath = path.join(this.certsDir, "mongodb-certs.list");
        const certListStats = await fs.stat(certListPath);
        dashboardData.systemStatus.certListValid = true;
        dashboardData.systemStatus.certListSize = certListStats.size;
        dashboardData.systemStatus.certListModified =
          certListStats.mtime.toISOString();
      } catch (err) {
        dashboardData.systemStatus.certListValid = false;
        dashboardData.systemStatus.certListError = err.message;
      }

      // Check HAProxy configuration validity
      try {
        const haproxyContainer = process.env.HAPROXY_CONTAINER || "haproxy";
        await execAsync(
          `docker exec ${haproxyContainer} haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg`
        );
        dashboardData.systemStatus.haproxyConfigValid = true;
      } catch (err) {
        dashboardData.systemStatus.haproxyConfigValid = false;
        dashboardData.systemStatus.haproxyError = err.message;
      }

      // Process each agent
      for (const agentId of agentDirs) {
        try {
          // Get certificate information
          const certInfo = await this.getCertificateInfo(agentId);

          // Get HAProxy configuration status for this agent
          const haproxyStatus = await this._getAgentHAProxyStatus(agentId);

          // Create agent certificate entry
          const agentCert = {
            agentId,
            exists: certInfo.exists,
            status: "unknown",
          };

          if (certInfo.exists) {
            agentCert.expiry = certInfo.expiry;
            agentCert.daysRemaining = certInfo.daysRemaining;
            agentCert.certPath = certInfo.certPath;

            // Determine certificate status
            if (certInfo.isExpired) {
              agentCert.status = "expired";
              dashboardData.metrics.expired++;
            } else if (certInfo.daysRemaining <= 30) {
              agentCert.status = "expiring";
              dashboardData.metrics.expiring++;
            } else {
              agentCert.status = "valid";
              dashboardData.metrics.valid++;
            }

            // Add HAProxy configuration status
            agentCert.haproxy = haproxyStatus;

            // Check for configuration issues
            if (!haproxyStatus.properly_configured) {
              dashboardData.metrics.configIssues++;
              agentCert.status = "config_issues";
            }
          } else {
            agentCert.status = "missing";
            dashboardData.metrics.missing++;
          }

          dashboardData.agentCertificates.push(agentCert);
        } catch (err) {
          // Handle errors for individual agents
          dashboardData.agentCertificates.push({
            agentId,
            status: "error",
            error: err.message,
          });

          // Increment error count
          dashboardData.metrics.missing++;
        }
      }

      // Sort certificates by status (expired first, then expiring, then other)
      dashboardData.agentCertificates.sort((a, b) => {
        // Define status priority (lower number = higher priority)
        const priority = {
          expired: 1,
          expiring: 2,
          config_issues: 3,
          missing: 4,
          valid: 5,
          error: 6,
          unknown: 7,
        };

        // Sort by priority, then by days remaining for same status
        if (a.status !== b.status) {
          return priority[a.status] - priority[b.status];
        }

        // For expiring or valid certificates, sort by days remaining
        if (
          (a.status === "expiring" || a.status === "valid") &&
          a.daysRemaining !== undefined &&
          b.daysRemaining !== undefined
        ) {
          return a.daysRemaining - b.daysRemaining;
        }

        // Otherwise sort by agent ID
        return a.agentId.localeCompare(b.agentId);
      });

      return dashboardData;
    } catch (err) {
      logger.error(`Failed to generate certificate dashboard: ${err.message}`);
      return {
        timestamp: new Date().toISOString(),
        error: err.message,
        success: false,
      };
    }
  }

  /**
   * Get information about the CA certificate
   * @returns {Promise<Object>} CA certificate information
   */
  async getCAInfo() {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      try {
        await fs.access(this.caCertPath);
        await fs.access(this.caKeyPath);
      } catch (_err) {
        return { exists: false };
      }

      // Get CA certificate info using OpenSSL
      const certInfo = execSync(
        `openssl x509 -in ${this.caCertPath} -text -noout`
      ).toString();

      // Parse expiration date and other details
      const expiryMatch = certInfo.match(/Not After\s*:\s*(.+)/);
      const issuedMatch = certInfo.match(/Not Before\s*:\s*(.+)/);
      const subjectMatch = certInfo.match(/Subject:(.+)/);
      const issuerMatch = certInfo.match(/Issuer:(.+)/);

      const expiry = expiryMatch ? new Date(expiryMatch[1]) : null;
      const now = new Date();
      const daysRemaining = expiry
        ? Math.ceil((expiry - now) / (1000 * 60 * 60 * 24))
        : null;

      const caStats = await fs.stat(this.caCertPath);

      return {
        exists: true,
        path: this.caCertPath,
        keyPath: this.caKeyPath,
        expiry: expiry ? expiry.toISOString() : null,
        issued: issuedMatch ? new Date(issuedMatch[1]).toISOString() : null,
        daysRemaining,
        isExpired: daysRemaining !== null && daysRemaining <= 0,
        subject: subjectMatch ? subjectMatch[1].trim() : null,
        issuer: issuerMatch ? issuerMatch[1].trim() : null,
        size: caStats.size,
        lastModified: caStats.mtime.toISOString(),
      };
    } catch (err) {
      logger.error(`Failed to get CA certificate info: ${err.message}`);
      return {
        exists: true,
        error: err.message,
      };
    }
  }

  /**
   * Get certificate info for all agents in the system
   * @returns {Promise<Object>} Certificate information for all agents
   */
  async getAllCertificates() {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info("Getting all certificate information");

      // Find all agent certificate directories
      const agentsDir = path.join(this.certsDir, "agents");
      let agentDirs;
      try {
        agentDirs = await fs.readdir(agentsDir);
      } catch (err) {
        logger.error(`Failed to read agents directory: ${err.message}`);
        return {
          success: false,
          error: `Failed to read agents directory: ${err.message}`,
        };
      }

      const results = {
        success: true,
        count: agentDirs.length,
        certificates: [],
      };

      // Process each agent
      for (const agentId of agentDirs) {
        try {
          const certInfo = await this.getCertificateInfo(agentId);
          results.certificates.push({
            agentId,
            ...certInfo,
          });
        } catch (err) {
          // Include error for this agent but continue processing others
          results.certificates.push({
            agentId,
            success: false,
            error: err.message,
          });
        }
      }

      return results;
    } catch (err) {
      logger.error(`Failed to get all certificate information: ${err.message}`);
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Get HAProxy status for a specific agent's certificate
   * @param {string} agentId - Agent ID
   * @returns {Promise<Object>} HAProxy configuration status
   * @private
   */
  async _getAgentHAProxyStatus(agentId) {
    const result = {
      properly_configured: false,
      details: {},
    };

    try {
      // Check for a single certificate approach
      const singleCertPath = path.join(this.certsDir, "mongodb.pem");
      try {
        await fs.access(singleCertPath);
        result.details.singleCertExists = true;
      } catch (err) {
        result.details.singleCertExists = false;
      }

      // Check for multi-certificate approach
      const mongodbCertsDir = path.join(this.certsDir, "mongodb");
      const agentPemPath = path.join(mongodbCertsDir, `${agentId}.pem`);
      try {
        await fs.access(agentPemPath);
        result.details.agentCertExists = true;
      } catch (err) {
        result.details.agentCertExists = false;
      }

      // Check certificate list
      const certListPath = path.join(this.certsDir, "mongodb-certs.list");
      try {
        const certListContent = await fs.readFile(certListPath, "utf-8");
        const entryPattern = new RegExp(
          `\\S+\\s+${agentId}\\.${this.mongoDomain}`
        );
        result.details.inCertList = entryPattern.test(certListContent);
      } catch (err) {
        result.details.inCertList = false;
        result.details.certListError = err.message;
      }

      // Check HAProxy API configuration
      try {
        const client = this._getApiClient();

        // Check backend
        const backendName = `${agentId}-mongodb-backend`;
        try {
          await client.get(
            `/services/haproxy/configuration/backends/${backendName}`
          );
          result.details.backendExists = true;
        } catch (err) {
          result.details.backendExists = false;
        }

        // Check certificate store
        const certStoreName = `mongodb_${agentId}_certs`;
        try {
          await client.get(
            `/services/haproxy/configuration/certificate_stores/${certStoreName}`
          );
          result.details.certStoreExists = true;
        } catch (err) {
          result.details.certStoreExists = false;
        }
      } catch (err) {
        result.details.apiError = err.message;
      }

      // Determine if properly configured
      result.properly_configured =
        (result.details.singleCertExists ||
          (result.details.agentCertExists && result.details.inCertList)) &&
        result.details.backendExists;
    } catch (err) {
      result.error = err.message;
    }

    return result;
  }

  // Add method to get provider capabilities
  getProviderCapabilities() {
    if (!this.provider) {
      return null;
    }
    return this.provider.getCapabilities();
  }

  // Add method to validate provider configuration
  async validateProviderConfig() {
    if (!this.provider) {
      return {
        valid: false,
        issues: ["No certificate provider configured"],
      };
    }
    return this.provider.validateConfig();
  }

  /**
   * Get dashboard data for certificates
   * @returns {Promise<Object>} Dashboard data including certificate counts, status, and recent activity
   */
  async getDashboardData() {
    try {
      const allCerts = await this.getAllCertificates();
      const caInfo = await this.getCAInfo();

      // Calculate certificate statistics
      const stats = {
        total: allCerts.length,
        active: allCerts.filter((cert) => cert.status === "active").length,
        expired: allCerts.filter((cert) => cert.status === "expired").length,
        expiringSoon: allCerts.filter((cert) => {
          const daysUntilExpiry = Math.floor(
            (new Date(cert.expiryDate) - new Date()) / (1000 * 60 * 60 * 24)
          );
          return daysUntilExpiry <= 30 && daysUntilExpiry > 0;
        }).length,
      };

      // Get recent certificate activity
      const recentActivity = allCerts
        .sort((a, b) => new Date(b.lastUpdated) - new Date(a.lastUpdated))
        .slice(0, 5)
        .map((cert) => ({
          agentId: cert.agentId,
          status: cert.status,
          lastUpdated: cert.lastUpdated,
          expiryDate: cert.expiryDate,
        }));

      return {
        stats,
        caInfo,
        recentActivity,
        provider: this.provider.getProviderInfo(),
      };
    } catch (error) {
      logger.error(`Error getting dashboard data: ${error.message}`);
      throw new AppError("Failed to get dashboard data", 500);
    }
  }

  /**
   * Set up event listeners for certificate monitoring events
   * @private
   */
  _setupEventListeners() {
    // Forward certificate monitor events
    this.certificateMonitor.on("certificate-warning", (data) => {
      this.emit("certificate-warning", data);
    });

    this.certificateMonitor.on("certificate-critical", (data) => {
      this.emit("certificate-critical", data);
    });

    this.certificateMonitor.on("certificate-expired", (data) => {
      this.emit("certificate-expired", data);
    });

    this.certificateMonitor.on("status-change", (data) => {
      this.emit("status-change", data);
    });
  }

  /**
   * Check certificate system health
   * @returns {Promise<boolean>} Health status
   * @private
   */
  async _checkCertificateSystemHealth() {
    try {
      // Check if certificate directories are accessible
      await fs.access(this.certsDir);

      // Check if CA certificate is accessible
      try {
        await fs.access(this.caCertPath);
        await fs.access(this.caKeyPath);
      } catch (caErr) {
        logger.warn(`CA certificate health check warning: ${caErr.message}`);
        // Continue with health check even if CA certificates are not accessible
      }

      // For now, consider the system healthy if basic paths are accessible
      return true;
    } catch (err) {
      logger.error(`Certificate system health check failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Get all active certificates
   * This method is used by the certificate monitor
   * @returns {Promise<Array>} List of active certificates
   */
  async getActiveCertificates() {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      // Find all agent certificate directories
      const agentsDir = path.join(this.certsDir, "agents");
      let agentDirs;

      try {
        agentDirs = await fs.readdir(agentsDir);
      } catch (err) {
        logger.error(`Failed to read agents directory: ${err.message}`);
        return [];
      }

      const certificates = [];

      // Process each agent certificate
      for (const agentId of agentDirs) {
        try {
          const certInfo = await this.getCertificateInfo(agentId);

          if (certInfo.exists) {
            certificates.push({
              domain: `${agentId}.${this.mongoDomain}`,
              name: agentId,
              valid: !certInfo.isExpired,
              expiresAt: certInfo.expiry,
              path: certInfo.certPath,
              daysRemaining: certInfo.daysRemaining,
            });
          }
        } catch (err) {
          logger.warn(
            `Error processing certificate for ${agentId}: ${err.message}`
          );
          // Continue with other certificates
        }
      }

      return certificates;
    } catch (err) {
      logger.error(`Failed to get active certificates: ${err.message}`);
      return [];
    }
  }

  /**
   * Create certificate with circuit breaking protection and resilience
   * Use this method for reliable certificate operations with built-in retry and circuit breaking
   * @param {string} agentId - Agent ID
   * @param {string} targetIp - Target IP address
   * @returns {Promise<Object>} Result with certificate paths
   */
  async createCertificateWithResilience(agentId, targetIp) {
    if (!this.initialized) {
      await this.initialize();
    }

    logger.info(`Creating certificate with resilience for agent ${agentId}`);

    try {
      // Use circuit breaker to prevent cascading failures
      return await this.circuitBreaker.execute(
        async () => {
          // Use retry handler for transient failures
          return await retryHandler.withRetry(
            async () => {
              // Call the actual certificate creation method
              return await this.createCertificateForAgent(agentId, targetIp);
            },
            {
              maxRetries: this.retryConfig.maxRetries,
              initialDelay: this.retryConfig.initialDelay,
              maxDelay: this.retryConfig.maxDelay,
              shouldRetry: (err) => {
                // Only retry if the error is not related to bad input
                // Transient errors like timeouts are retryable
                return (
                  !err.message.includes("Invalid") &&
                  !err.message.includes("Bad request") &&
                  !err.message.includes("Not found")
                );
              },
              onRetry: (err, attempt) => {
                logger.warn(
                  `Retry ${attempt}/${this.retryConfig.maxRetries} creating certificate for ${agentId}: ${err.message}`
                );
              },
            }
          );
        },
        `Create certificate for ${agentId}`,
        "create" // Operation type for rate limiting
      );
    } catch (err) {
      logger.error(
        `Failed to create certificate for ${agentId} with resilience: ${err.message}`
      );
      throw err;
    }
  }

  /**
   * Renew certificate with circuit breaking protection and resilience
   * Use this method for reliable certificate renewal with built-in retry and circuit breaking
   * @param {string} agentId - Agent ID
   * @param {string} targetIp - Target IP address
   * @returns {Promise<Object>} Result with certificate paths
   */
  async renewCertificateWithResilience(agentId, targetIp) {
    if (!this.initialized) {
      await this.initialize();
    }

    logger.info(`Renewing certificate with resilience for agent ${agentId}`);

    try {
      // Use circuit breaker to prevent cascading failures
      return await this.circuitBreaker.execute(
        async () => {
          // Use retry handler for transient failures
          return await retryHandler.withRetry(
            async () => {
              // Call the actual certificate renewal method
              return await this.renewCertificate(agentId, targetIp);
            },
            {
              maxRetries: this.retryConfig.maxRetries,
              initialDelay: this.retryConfig.initialDelay,
              maxDelay: this.retryConfig.maxDelay,
              shouldRetry: (err) => {
                // Only retry on transient errors
                return (
                  !err.message.includes("Invalid") &&
                  !err.message.includes("Bad request") &&
                  !err.message.includes("Not found")
                );
              },
              onRetry: (err, attempt) => {
                logger.warn(
                  `Retry ${attempt}/${this.retryConfig.maxRetries} renewing certificate for ${agentId}: ${err.message}`
                );
              },
            }
          );
        },
        `Renew certificate for ${agentId}`,
        "renew" // Operation type for rate limiting
      );
    } catch (err) {
      logger.error(
        `Failed to renew certificate for ${agentId} with resilience: ${err.message}`
      );
      throw err;
    }
  }

  /**
   * Schedule certificate renewals
   * @private
   */
  async _scheduleRenewals() {
    // Clear any existing schedule
    this.renewalSchedule = [];

    // Get all active certificates
    const certificates = await this.getActiveCertificates();

    // Calculate renewal dates
    for (const cert of certificates) {
      if (cert.valid && cert.expiresAt) {
        const expiresAt = new Date(cert.expiresAt);
        const renewalDate = new Date(expiresAt);

        // Set renewal to occur defaultRenewalDays before expiry
        renewalDate.setDate(renewalDate.getDate() - this.defaultRenewalDays);

        this.renewalSchedule.push({
          domain: cert.domain,
          name: cert.name,
          expiresAt: cert.expiresAt,
          renewalDate: renewalDate.toISOString(),
        });
      }
    }

    // Sort by renewal date (earliest first)
    this.renewalSchedule.sort((a, b) => {
      return new Date(a.renewalDate) - new Date(b.renewalDate);
    });

    // Schedule next check
    this._scheduleNextRenewalCheck();

    logger.info(
      `Scheduled renewals for ${this.renewalSchedule.length} certificates`
    );
  }

  /**
   * Schedule the next renewal check
   * @private
   */
  _scheduleNextRenewalCheck() {
    // Clear any existing timer
    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer);
    }

    // Schedule the next renewal check
    this.renewalTimer = setTimeout(async () => {
      await this._checkRenewals();

      // Schedule next check
      this._scheduleNextRenewalCheck();
    }, this.renewalScheduleInterval);

    // Prevent timer from blocking Node exit
    if (this.renewalTimer.unref) {
      this.renewalTimer.unref();
    }

    logger.debug(
      `Next renewal check scheduled in ${
        this.renewalScheduleInterval / 1000
      } seconds`
    );
  }

  /**
   * Check for certificates that need renewal
   * @private
   */
  async _checkRenewals() {
    try {
      logger.info("Checking for certificate renewals");

      const now = new Date();
      let renewedCount = 0;

      for (const item of this.renewalSchedule) {
        const renewalDate = new Date(item.renewalDate);

        // If renewal date is in the past or today, attempt renewal
        if (renewalDate <= now) {
          try {
            logger.info(`Certificate for ${item.name} needs renewal`);

            // Extract agent ID from domain name
            const agentId = item.name;

            // Get certificate info to extract target IP if available
            const certInfo = await this.getCertificateInfo(agentId);
            let targetIp = null;

            if (certInfo.summary) {
              // Try to extract IP address from certificate
              const ipMatch = certInfo.summary.match(
                /IP Address:(\d+\.\d+\.\d+\.\d+)/
              );
              if (ipMatch && ipMatch[1]) {
                targetIp = ipMatch[1];
              }
            }

            // Attempt to renew
            await this.renewCertificateWithResilience(agentId, targetIp);
            renewedCount++;

            // Emit renewal event
            this.emit("certificate-renewed", {
              domain: item.domain,
              name: item.name,
              previousExpiry: item.expiresAt,
            });
          } catch (err) {
            logger.error(
              `Scheduled renewal failed for ${item.name}: ${err.message}`
            );

            // Emit renewal failure event
            this.emit("certificate-renewal-failed", {
              domain: item.domain,
              name: item.name,
              error: err.message,
            });
          }
        }
      }

      if (renewedCount > 0) {
        logger.info(`Renewed ${renewedCount} certificates`);
      } else {
        logger.debug("No certificates needed renewal");
      }

      // Update the renewal schedule
      await this._scheduleRenewals();
    } catch (err) {
      logger.error(`Error checking renewals: ${err.message}`);
    }
  }

  /**
   * Start certificate monitoring and periodic checks
   * Call this method to enable automatic certificate monitoring and renewal
   */
  startMonitoring() {
    if (!this.initialized) {
      logger.warn(
        "Certificate service not initialized, monitoring not started"
      );
      return;
    }

    // Start certificate monitor
    this.certificateMonitor.start();

    // Start circuit breaker health checks
    this.circuitBreaker.startHealthChecks();

    // Schedule initial renewal check
    this._scheduleRenewals();

    logger.info("Certificate monitoring started");
  }

  /**
   * Stop certificate monitoring and periodic checks
   */
  stopMonitoring() {
    // Stop certificate monitor
    if (this.certificateMonitor) {
      this.certificateMonitor.stop();
    }

    // Stop circuit breaker health checks
    if (this.circuitBreaker) {
      this.circuitBreaker.stopHealthChecks();
    }

    // Clear renewal timer
    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer);
      this.renewalTimer = null;
    }

    logger.info("Certificate monitoring stopped");
  }

  /**
   * Get certificate system status
   * @returns {Promise<Object>} Status information including circuit breaker state,
   * monitoring status, and renewal schedule
   */
  async getStatus() {
    return {
      initialized: this.initialized,
      circuitBreaker: this.circuitBreaker.getStatus(),
      certificates: (await this.certificateMonitor?.getStatus()) || {},
      renewalSchedule: [...this.renewalSchedule],
      provider: this.provider?.getProviderInfo() || { type: "unknown" },
    };
  }

  /**
   * Force a refresh of certificate status
   * @returns {Promise<Object>} Updated status
   */
  async refreshStatus() {
    if (this.certificateMonitor) {
      await this.certificateMonitor.checkCertificates();
    }
    return this.getStatus();
  }
}

module.exports = CertificateService;
