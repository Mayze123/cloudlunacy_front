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
const FileLock = require("../../utils/fileLock");
const retryHandler = require("../../utils/retryHandler");
const CertificateProviderFactory = require("../../utils/certProviders/providerFactory");

// Constants
const CERTIFICATE_LOCK_PREFIX = "cert";
const HAPROXY_RELOAD_LOCK = "haproxy_reload";
const CERTIFICATE_LIST_LOCK = "certificate_list";
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

class CertificateService {
  constructor() {
    this.initialized = false;
    this.certsDir = null;
    this.caCertPath = null;
    this.caKeyPath = null;
    this.mongoDomain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";

    // Data Plane API configuration
    this.apiBaseUrl = process.env.HAPROXY_API_URL || "http://localhost:5555/v3";
    this.apiUsername = process.env.HAPROXY_API_USER || "admin";
    this.apiPassword = process.env.HAPROXY_API_PASS || "admin";

    // Initialize certificate provider using factory
    const providerType = process.env.CERT_PROVIDER_TYPE || "self-signed";
    this.provider = this._createProvider(providerType);
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

      // Initialize the certificate provider
      // Note: We don't need to check needsInitialization as all providers should be initialized
      try {
        await this.provider.initialize();
        logger.info("Certificate provider initialized successfully");
      } catch (providerErr) {
        logger.warn(
          `Certificate provider initialization warning: ${providerErr.message}`
        );
        // Continue even if provider initialization fails, as we can still use basic operations
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

          // Create agent directory
          const agentCertDir = path.join(this.certsDir, "agents", agentId);
          await fs.mkdir(agentCertDir, { recursive: true });

          // Define paths
          const keyPath = path.join(agentCertDir, "server.key");
          const csrPath = path.join(agentCertDir, "server.csr");
          const certPath = path.join(agentCertDir, "server.crt");
          const pemPath = path.join(agentCertDir, "server.pem");
          const tempKeyPath = path.join(agentCertDir, ".server.key.tmp");
          const tempCertPath = path.join(agentCertDir, ".server.crt.tmp");
          const tempPemPath = path.join(agentCertDir, ".server.pem.tmp");
          const configPath = path.join(agentCertDir, "openssl.cnf");
          const mongoSubdomain = `${agentId}.${this.mongoDomain}`;

          // Validate IP address to prevent OpenSSL errors
          const isValidIP = (ip) => {
            if (!ip || typeof ip !== "string") return false;

            // IPv4 validation
            const ipv4Regex =
              /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

            // IPv6 validation (simplified)
            const ipv6Regex =
              /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::1$|^::$|^([0-9a-fA-F]{1,4}:){0,6}::([0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}$/;

            return ipv4Regex.test(ip) || ipv6Regex.test(ip);
          };

          // Log the target IP for debugging
          logger.debug(
            `Certificate generation for ${agentId} with targetIp: ${targetIp}`
          );

          // Create OpenSSL configuration with proper IP handling
          let opensslConfig = `
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
`;

          // Only add the IP as DNS.3 if it's not a valid IP address
          if (!isValidIP(targetIp)) {
            opensslConfig += `DNS.3 = ${targetIp || "localhost"}\n`;
          } else {
            opensslConfig += `DNS.3 = localhost\n`;
          }

          // Only add IP.1 if targetIp is actually a valid IP address
          if (isValidIP(targetIp)) {
            opensslConfig += `IP.1 = ${targetIp}\n`;
          } else {
            // Fallback to localhost if the provided targetIp is not a valid IP
            opensslConfig += `IP.1 = 127.0.0.1\n`;
          }

          // Write OpenSSL configuration
          await fs.writeFile(configPath, opensslConfig);

          try {
            // Generate private key to temporary file first
            execSync(`openssl genrsa -out ${tempKeyPath} 2048`);

            // Generate CSR
            execSync(
              `openssl req -new -key ${tempKeyPath} -out ${csrPath} -config ${configPath}`
            );

            // Sign certificate with CA
            execSync(
              `openssl x509 -req -in ${csrPath} -CA ${this.caCertPath} -CAkey ${this.caKeyPath} -CAcreateserial -out ${tempCertPath} -days 365 -extensions v3_req -extfile ${configPath}`
            );

            // Create combined PEM file for HAProxy
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

            // Copy certificates to HAProxy directory
            const updateResult = await this.updateHAProxyCertificates(
              agentId,
              certPath,
              keyPath,
              pemPath
            );

            logger.info(`Certificate created for agent ${agentId}`);
            return {
              success: true,
              keyPath,
              certPath,
              pemPath,
              caPath: this.caCertPath,
              haproxyUpdated: updateResult.success,
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
   * Get agent certificate files
   * @param {string} agentId - Agent ID
   * @returns {Promise<Object>} Certificate files and paths
   */
  async getAgentCertificates(agentId) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      const agentCertDir = path.join(this.certsDir, "agents", agentId);
      const keyPath = path.join(agentCertDir, "server.key");
      const certPath = path.join(agentCertDir, "server.crt");
      const pemPath = path.join(agentCertDir, "server.pem");

      // Check if certificate exists
      try {
        await fs.access(certPath);
        await fs.access(keyPath);
      } catch (err) {
        logger.warn(`Certificates for agent ${agentId} not found`);
        return {
          success: false,
          error: `Certificates for agent ${agentId} not found`,
        };
      }

      // Read certificate files
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
      };
    } catch (err) {
      logger.error(
        `Failed to get agent certificates for ${agentId}: ${err.message}`
      );
      throw err;
    }
  }

  /**
   * Reload HAProxy to apply certificate changes
   * @returns {Promise<Object>} Result of the operation
   */
  async reloadHAProxy() {
    // Use lock to prevent multiple simultaneous reloads
    try {
      const lock = await FileLock.acquire(HAPROXY_RELOAD_LOCK, 10000);
      if (!lock.success) {
        logger.info(
          "HAProxy reload already in progress, skipping duplicate reload"
        );
        return {
          success: true,
          message: "HAProxy reload already in progress by another process",
        };
      }

      try {
        logger.info("Reloading HAProxy to apply certificate changes");

        // Create a function to retry with both methods
        const reloadWithRetries = async () => {
          // First try using Docker command
          try {
            const haproxyContainer = process.env.HAPROXY_CONTAINER || "haproxy";
            const execTimeout = 15000; // 15-second timeout for Docker commands

            // Validate configuration before reloading
            try {
              // Use promises with timeout to avoid hanging
              await Promise.race([
                execAsync(
                  `docker exec ${haproxyContainer} haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg`
                ),
                new Promise((_, reject) => 
                  setTimeout(() => reject(new Error("Docker exec command timed out after 15 seconds")), execTimeout)
                )
              ]);
              
              logger.info("HAProxy configuration validated successfully");
            } catch (validationErr) {
              logger.error(
                `HAProxy configuration validation failed: ${validationErr.message}`
              );
              throw new Error(
                `Invalid HAProxy configuration: ${validationErr.message}`
              );
            }

            // Reload HAProxy with timeout
            await Promise.race([
              execAsync(
                `docker exec ${haproxyContainer} service haproxy reload`
              ),
              new Promise((_, reject) => 
                setTimeout(() => reject(new Error("HAProxy reload command timed out after 15 seconds")), execTimeout)
              )
            ]);

            // Verify that HAProxy is still running after reload with timeout
            const { stdout } = await Promise.race([
              execAsync(
                `docker ps -q -f name=${haproxyContainer}`
              ),
              new Promise((_, reject) => 
                setTimeout(() => reject(new Error("Docker ps command timed out after 15 seconds")), execTimeout)
              )
            ]);
            
            if (!stdout.trim()) {
              throw new Error("HAProxy is not running after reload attempt");
            }

            logger.info("HAProxy reloaded successfully via Docker command");
            return { success: true, message: "HAProxy reloaded successfully" };
          } catch (dockerErr) {
            logger.warn(
              `Failed to reload HAProxy via Docker: ${dockerErr.message}`
            );

            // Fallback to Data Plane API
            try {
              const client = this._getApiClient();
              await client.post("/services/haproxy/reload");
              logger.info("HAProxy reloaded successfully via Data Plane API");
              return {
                success: true,
                message: "HAProxy reloaded successfully via API",
              };
            } catch (apiErr) {
              logger.error(
                `Failed to reload HAProxy via API: ${apiErr.message}`
              );
              throw apiErr;
            }
          }
        };

        // Use the retry handler to retry the reload operation
        return await retryHandler.withRetry(reloadWithRetries, {
          maxAttempts: MAX_RETRY_ATTEMPTS,
          retryDelay: RETRY_DELAY_MS,
          onRetry: (error, attempt) => {
            logger.warn(
              `Retry ${attempt}/${MAX_RETRY_ATTEMPTS} reloading HAProxy: ${error.message}`
            );
          },
        });
      } finally {
        // Always release the lock when done
        await lock.release();
      }
    } catch (err) {
      logger.error(`Failed to reload HAProxy: ${err.message}`);
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

  async updateHAProxyCertificates(agentId, certPath, keyPath, pemPath) {
    // Use a lock to prevent concurrent updates to the certificate list
    const certificateListLock = `${CERTIFICATE_LIST_LOCK}`;

    try {
      logger.info(`Updating HAProxy certificates for agent ${agentId}`);

      // Ensure minimal certificate exists first for HAProxy startup
      await this.ensureMinimalCertificate();

      // Use the host paths instead of container paths
      const hostCertsDir = this.certsDir;
      const mongodbCertsDir = path.join(hostCertsDir, "mongodb");
      const certListPath = path.join(hostCertsDir, "mongodb-certs.list");
      const singleCertPath = path.join(hostCertsDir, "mongodb.pem");
      const tempPemPath = path.join(hostCertsDir, `.${agentId}.temp.pem`);

      try {
        // Create directories if they don't exist
        await fs.mkdir(hostCertsDir, { recursive: true });
        await fs.mkdir(path.join(hostCertsDir, "private"), { recursive: true });

        // Create a temporary file first, then move atomically to avoid race conditions
        // Even though we have locking, this adds an extra layer of protection
        await fs.copyFile(pemPath, tempPemPath);
        await fs.chmod(tempPemPath, 0o600);

        // This is a critical section that modifies shared resources - use lock
        return await FileLock.withLock(
          certificateListLock,
          async () => {
            // Always ensure the single certificate is updated (for backward compatibility)
            // This will be available in the container at /etc/ssl/certs/mongodb.pem
            await fs.rename(tempPemPath, singleCertPath);
            logger.info(
              `Updated single certificate at ${singleCertPath} for backward compatibility`
            );

            // Try to upgrade to the multi-certificate structure if possible
            try {
              // Create mongodb directory if it doesn't exist
              await fs.mkdir(mongodbCertsDir, { recursive: true });

              // Define agent-specific filenames
              const agentPemPath = path.join(mongodbCertsDir, `${agentId}.pem`);
              const agentTempPemPath = path.join(
                mongodbCertsDir,
                `.${agentId}.temp.pem`
              );

              // Copy PEM file to agent-specific location using atomic rename
              await fs.copyFile(pemPath, agentTempPemPath);
              await fs.chmod(agentTempPemPath, 0o600);
              await fs.rename(agentTempPemPath, agentPemPath);

              // Also maintain backwards compatibility with individual cert/key files
              const certsFilename = `${agentId}-mongodb.crt`;
              const keyFilename = `${agentId}-mongodb.key`;
              const targetCertPath = path.join(hostCertsDir, certsFilename);
              const targetKeyPath = path.join(
                hostCertsDir,
                "private",
                keyFilename
              );
              const tempCertPath = path.join(
                hostCertsDir,
                `.${certsFilename}.temp`
              );
              const tempKeyPath = path.join(
                hostCertsDir,
                "private",
                `.${keyFilename}.temp`
              );

              // Copy with atomic rename operations
              await fs.copyFile(certPath, tempCertPath);
              await fs.copyFile(keyPath, tempKeyPath);
              await fs.chmod(tempCertPath, 0o644);
              await fs.chmod(tempKeyPath, 0o600);
              await fs.rename(tempCertPath, targetCertPath);
              await fs.rename(tempKeyPath, targetKeyPath);

              logger.info(
                `Copied certificates to host directories for agent ${agentId}`
              );

              // Add entry to certificate list file
              // Make sure to use container path in the list entry since HAProxy will read it there
              const containerAgentPemPath = `/etc/ssl/certs/mongodb/${agentId}.pem`;
              const certListEntry = `${containerAgentPemPath} ${agentId}.${this.mongoDomain}\n`;

              try {
                // Check if certificate list file exists and if entry is already present
                let currentList = "";
                let listExists = false;

                try {
                  currentList = await fs.readFile(certListPath, "utf-8");
                  listExists = true;
                } catch {
                  // File doesn't exist, will create a new one
                  logger.info(
                    `Certificate list file doesn't exist, creating a new one at ${certListPath}`
                  );
                  // Initialize with header
                  currentList =
                    "# HAProxy Certificate List for MongoDB\n# Format: <path> <SNI>\n\n";
                }

                if (!currentList.includes(certListEntry)) {
                  // Append the new entry to the list - write to temp first then rename for atomicity
                  const tempListPath = `${certListPath}.tmp`;
                  await fs.writeFile(tempListPath, currentList + certListEntry);
                  await fs.chmod(tempListPath, 0o644);
                  await fs.rename(tempListPath, certListPath);
                  logger.info(
                    `Added agent ${agentId} certificate to the certificate list`
                  );
                } else {
                  logger.info(
                    `Certificate for agent ${agentId} already in certificate list`
                  );
                }

                // If we've successfully set up the certificate list, we should also check if we need to update HAProxy config
                if (!listExists) {
                  try {
                    logger.info(
                      "Successfully created certificate list for future use"
                    );
                    // In the future, we can automatically update HAProxy config to use the certificate list
                  } catch (configErr) {
                    logger.warn(
                      `Failed to prepare for future certificate list usage: ${configErr.message}`
                    );
                  }
                }
              } catch (listErr) {
                logger.error(
                  `Failed to update certificate list file: ${listErr.message}`
                );
                logger.info("Continuing with single certificate approach");
              }
            } catch (multiCertErr) {
              logger.warn(
                `Failed to set up multi-certificate structure: ${multiCertErr.message}`
              );
              logger.info("Continuing with single certificate approach");
            }

            // Reload HAProxy to apply certificate changes - this works for both approaches
            const reloadResult = await this.reloadHAProxy();

            // Update HAProxy configuration via Data Plane API
            const apiResult = await this.updateHAProxyTlsConfig(
              agentId,
              pemPath
            );

            return {
              success: reloadResult.success && apiResult.success,
              reloadResult,
              apiResult,
              message: `Certificate updates applied for agent ${agentId}`,
            };
          },
          60000
        ); // 20 second timeout for the lock
      } catch (copyErr) {
        // Clean up temporary file if it exists
        try {
          await fs.unlink(tempPemPath).catch(() => {});
        } catch (cleanupErr) {
          logger.debug(`Failed to clean up temp file: ${cleanupErr.message}`);
        }

        logger.warn(
          `Failed to copy certificates to system locations: ${copyErr.message}`
        );
        // Even if copying to system locations fails, try to update HAProxy via the API
        return this.updateHAProxyTlsConfig(agentId, pemPath);
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
    // Use retry handler for the entire operation
    return await retryHandler
      .withRetry(
        async () => {
          let transactionId = null;

          try {
            const client = this._getApiClient();

            // Start a transaction
            const transactionResponse = await client.post(
              "/services/haproxy/transactions"
            );
            transactionId = transactionResponse.data.id;

            logger.info(
              `Started HAProxy transaction ${transactionId} for TLS config update for agent ${agentId}`
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
                if (err.response && err.response.status === 404) {
                  certStoreExists = false;
                } else {
                  // Re-throw unexpected errors
                  throw err;
                }
              }

              // Create or update certificate store
              if (certStoreExists) {
                await client.put(
                  `/services/haproxy/configuration/certificate_stores/${certStoreName}?transaction_id=${transactionId}`,
                  {
                    crt_list: pemPath,
                  }
                );
                logger.debug(
                  `Updated existing certificate store ${certStoreName}`
                );
              } else {
                await client.post(
                  `/services/haproxy/configuration/certificate_stores?transaction_id=${transactionId}`,
                  {
                    name: certStoreName,
                    crt_list: pemPath,
                  }
                );
                logger.debug(`Created new certificate store ${certStoreName}`);
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
                if (err.response && err.response.status === 404) {
                  backendExists = false;
                } else {
                  // Re-throw unexpected errors
                  throw err;
                }
              }

              // Update backend SSL configuration only if it exists
              // We don't create it here as that's handled by HAProxyService
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
                logger.debug(`Updated SSL config for backend ${backendName}`);
              } else {
                logger.info(
                  `Backend ${backendName} doesn't exist yet, skipping SSL configuration`
                );
              }

              // Verify the transaction changes before committing
              try {
                const changes = await client.get(
                  `/services/haproxy/transactions/${transactionId}`
                );
                const changeCount = changes.data.version || 0;

                if (changeCount === 0) {
                  logger.info(
                    `No changes detected in transaction ${transactionId}, skipping commit`
                  );

                  // Delete the empty transaction
                  await client.delete(
                    `/services/haproxy/transactions/${transactionId}`
                  );
                  transactionId = null;

                  return {
                    success: true,
                    message: `No changes needed to HAProxy TLS configuration for agent ${agentId}`,
                  };
                }

                logger.info(
                  `Committing transaction ${transactionId} with ${changeCount} changes`
                );
              } catch (err) {
                logger.warn(
                  `Error checking transaction changes: ${err.message}`
                );
                // Continue with commit anyway
              }

              // Commit the transaction
              await client.put(
                `/services/haproxy/transactions/${transactionId}`
              );
              logger.info(
                `Committed HAProxy transaction ${transactionId} for TLS config update for agent ${agentId}`
              );

              // Transaction committed successfully, set to null to prevent cleanup
              transactionId = null;

              return {
                success: true,
                message: `Updated HAProxy TLS configuration for agent ${agentId}`,
              };
            } catch (err) {
              throw err;
            }
          } catch (err) {
            // Clean up transaction if it exists and wasn't committed
            if (transactionId) {
              try {
                const client = this._getApiClient();
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
            }

            logger.error(
              `Failed to update HAProxy TLS config for agent ${agentId}: ${err.message}`,
              {
                error: err.message,
                stack: err.stack,
              }
            );

            // Determine if error is retryable
            const isRetryable =
              // Network errors
              err.code === "ECONNREFUSED" ||
              err.code === "ECONNRESET" ||
              err.code === "ETIMEDOUT" ||
              // HTTP 5xx errors
              (err.response && err.response.status >= 500) ||
              // HTTP 429 rate limit errors
              (err.response && err.response.status === 429);

            if (!isRetryable) {
              // Don't retry for client errors or other non-transient issues
              throw err;
            }

            // Throw the error to trigger a retry if appropriate
            throw err;
          }
        },
        {
          maxAttempts: MAX_RETRY_ATTEMPTS,
          retryDelay: RETRY_DELAY_MS,
          onRetry: (error, attempt) => {
            logger.warn(
              `Retry ${attempt}/${MAX_RETRY_ATTEMPTS} updating HAProxy TLS config for agent ${agentId}: ${error.message}`
            );
          },
          shouldRetry: (error) => {
            // Retry on network errors or server errors (5xx)
            return (
              error.code === "ECONNREFUSED" ||
              error.code === "ECONNRESET" ||
              error.code === "ETIMEDOUT" ||
              (error.response && error.response.status >= 500) ||
              (error.response && error.response.status === 429)
            );
          },
        }
      )
      .catch((err) => {
        // Fallback error handling if retries fail
        return {
          success: false,
          error: err.message,
        };
      });
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
            const lock = await FileLock.acquire(lockId, 5000);

            if (!lock.success) {
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
              // Always release the lock
              await lock.release();
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
}

module.exports = CertificateService;
