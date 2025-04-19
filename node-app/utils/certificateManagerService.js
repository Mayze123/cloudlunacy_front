/**
 * Certificate Manager Service
 *
 * A unified service that handles all certificate operations to ensure
 * consistency between Node.js application and HAProxy.
 *
 * This service acts as the single source of truth for certificate operations,
 * coordinates certificate generation, renewal, and distribution, and
 * ensures proper file permissions and directory structure.
 */

const fs = require("fs").promises;
const path = require("path");
const { execSync } = require("child_process");
const logger = require("./logger").getLogger("certificateManagerService");
const pathManager = require("./pathManager");
const fileLock = require("./fileLock");

class CertificateManagerService {
  constructor() {
    // Define certificate directories
    this.certsBaseDir = pathManager.resolvePath("certs");
    this.privateDir = path.join(this.certsBaseDir, "private");
    this.agentsDir = path.join(this.certsBaseDir, "agents");

    // HAProxy certificate directories
    this.haproxyCertsDir = "/etc/ssl/certs";
    this.haproxyPrivateDir = "/etc/ssl/private";

    // Certificate file paths
    this.caCertPath = path.join(this.certsBaseDir, "ca.crt");
    this.caKeyPath = path.join(this.certsBaseDir, "ca.key");
    this.caSrlPath = path.join(this.certsBaseDir, "ca.srl");

    this.initialized = false;
  }

  /**
   * Initialize the certificate manager service
   * Creates necessary directories and sets up initial structure
   */
  async initialize() {
    logger.info("Initializing certificate manager service");

    try {
      // Create required directories if they don't exist
      await this._ensureDirectories([
        this.certsBaseDir,
        this.privateDir,
        this.agentsDir,
      ]);

      // Check if CA certificates exist, create if needed
      await this._ensureRootCA();

      // Sync certificates to HAProxy directories
      await this.syncCertificatesToHAProxy();

      this.initialized = true;
      logger.info("Certificate manager service initialized successfully");
      return true;
    } catch (err) {
      logger.error(
        `Failed to initialize certificate manager service: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
        }
      );
      throw err;
    }
  }

  /**
   * Ensure all required directories exist
   * @param {Array<string>} directories - Array of directory paths
   * @private
   */
  async _ensureDirectories(directories) {
    for (const dir of directories) {
      try {
        await fs.mkdir(dir, { recursive: true });
        logger.debug(`Ensured directory exists: ${dir}`);
      } catch (err) {
        logger.error(`Failed to create directory ${dir}: ${err.message}`);
        throw err;
      }
    }
  }

  /**
   * Ensure Root CA certificate exists
   * @private
   */
  async _ensureRootCA() {
    // Check if CA exists
    try {
      await fs.access(this.caCertPath);
      await fs.access(this.caKeyPath);
      logger.debug("Root CA certificate already exists");
      return;
    } catch (err) {
      // CA doesn't exist, create it
      logger.info("Root CA certificate not found, creating...");

      try {
        // Generate new CA certificate using OpenSSL
        execSync(`openssl genrsa -out "${this.caKeyPath}" 4096`);
        execSync(
          `openssl req -x509 -new -nodes -key "${this.caKeyPath}" -sha256 -days 3650 -out "${this.caCertPath}" -subj "/C=US/ST=CA/L=San Francisco/O=CloudLunacy/OU=Security/CN=CloudLunacy Root CA"`
        );

        // Create symlink for MongoDB CA certificate
        const mongodbCaCertPath = path.join(
          this.certsBaseDir,
          "mongodb-ca.crt"
        );
        await fs.symlink(this.caCertPath, mongodbCaCertPath);

        logger.info("Root CA certificate created successfully");
      } catch (err) {
        logger.error(`Failed to create Root CA certificate: ${err.message}`);
        throw err;
      }
    }
  }

  /**
   * Generate certificate for an agent
   * @param {string} agentId - The agent ID
   * @param {string} targetIp - The agent IP address
   * @returns {Promise<Object>} Certificate generation result
   */
  async generateAgentCertificate(agentId, targetIp) {
    if (!this.initialized) {
      await this.initialize();
    }

    logger.info(
      `Generating certificate for agent ${agentId} with IP ${targetIp}`
    );

    // Use file lock to prevent concurrent certificate generation
    const lockId = `agent-cert-${agentId}`;
    const lock = await fileLock.acquireLock(lockId, 30000); // 30-second timeout

    try {
      // Ensure agent directory exists
      const agentDir = path.join(this.agentsDir, agentId);
      await this._ensureDirectories([agentDir]);

      // Certificate paths
      const serverKeyPath = path.join(agentDir, "server.key");
      const serverCsrPath = path.join(agentDir, "server.csr");
      const serverCertPath = path.join(agentDir, "server.crt");
      const agentCaCertPath = path.join(agentDir, "ca.crt");

      // Generate private key
      execSync(`openssl genrsa -out "${serverKeyPath}" 2048`);

      // Create extension file for SAN
      const extFile = path.join(agentDir, "server.ext");
      const extContent = `
subjectAltName = @alt_names
[alt_names]
IP.1 = ${targetIp}
IP.2 = 127.0.0.1
DNS.1 = ${agentId}
DNS.2 = localhost
      `.trim();
      await fs.writeFile(extFile, extContent);

      // Create CSR
      execSync(
        `openssl req -new -key "${serverKeyPath}" -out "${serverCsrPath}" -subj "/C=US/ST=CA/L=San Francisco/O=CloudLunacy/OU=Agents/CN=${agentId}"`
      );

      // Sign certificate with our CA
      execSync(
        `openssl x509 -req -in "${serverCsrPath}" -CA "${this.caCertPath}" -CAkey "${this.caKeyPath}" -CAcreateserial -out "${serverCertPath}" -days 825 -extfile "${extFile}"`
      );

      // Copy CA certificate to agent directory
      await fs.copyFile(this.caCertPath, agentCaCertPath);

      // Read generated certificates
      const [serverKey, serverCert, caCert] = await Promise.all([
        fs.readFile(serverKeyPath, "utf8"),
        fs.readFile(serverCertPath, "utf8"),
        fs.readFile(agentCaCertPath, "utf8"),
      ]);

      // Create combined PEM file for HAProxy
      const combinedPemPath = path.join(agentDir, "server.pem");
      await fs.writeFile(combinedPemPath, `${serverKey}\n${serverCert}`);

      // Sync to HAProxy directories
      await this.syncCertificatesToHAProxy();

      logger.info(`Certificate for agent ${agentId} generated successfully`);

      return {
        success: true,
        serverKey,
        serverCert,
        caCert,
        paths: {
          serverKeyPath,
          serverCertPath,
          agentCaCertPath,
          combinedPemPath,
        },
      };
    } catch (err) {
      logger.error(
        `Failed to generate certificate for agent ${agentId}: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
          agentId,
          targetIp,
        }
      );

      return {
        success: false,
        error: err.message,
        transient:
          err.message.includes("temporarily") ||
          err.message.includes("timeout") ||
          err.message.includes("busy"),
      };
    } finally {
      // Release lock
      await fileLock.releaseLock(lockId, lock);
    }
  }

  /**
   * Sync all certificates to HAProxy directories
   * Ensures HAProxy has the latest certificates
   */
  async syncCertificatesToHAProxy() {
    logger.info("Syncing certificates to HAProxy directories");

    try {
      // Check if HAProxy directories exist in Docker environment
      const haproxyDirsExist = await this._checkHAProxyDirs();

      if (!haproxyDirsExist) {
        logger.warn("HAProxy directories not found, skipping sync");
        return false;
      }

      // Copy CA certificates to HAProxy certs dir
      try {
        execSync(`docker exec haproxy mkdir -p ${this.haproxyCertsDir}`);
        execSync(`docker exec haproxy mkdir -p ${this.haproxyPrivateDir}`);

        // Copy CA cert to HAProxy certs dir
        await this._copyToHAProxyDir(
          this.caCertPath,
          path.join(this.haproxyCertsDir, "ca.crt")
        );
        await this._copyToHAProxyDir(
          this.caCertPath,
          path.join(this.haproxyCertsDir, "mongodb-ca.crt")
        );

        // Copy CA key to HAProxy private dir
        await this._copyToHAProxyDir(
          this.caKeyPath,
          path.join(this.haproxyPrivateDir, "ca.key")
        );

        // Copy agent certificates to HAProxy dirs
        const agentDirs = await fs.readdir(this.agentsDir);

        for (const agentId of agentDirs) {
          const agentDir = path.join(this.agentsDir, agentId);
          const stat = await fs.stat(agentDir);

          if (stat.isDirectory()) {
            // Copy combined PEM file for HAProxy
            const combinedPemPath = path.join(agentDir, "server.pem");
            try {
              await fs.access(combinedPemPath);
              await this._copyToHAProxyDir(
                combinedPemPath,
                path.join(this.haproxyPrivateDir, `${agentId}.pem`)
              );
              logger.debug(`Synced ${agentId}.pem to HAProxy private dir`);
            } catch (err) {
              logger.warn(
                `No combined PEM file found for agent ${agentId}, skipping`
              );
            }
          }
        }

        logger.info("Certificate sync to HAProxy completed successfully");
        return true;
      } catch (err) {
        logger.error(`Failed to sync certificates to HAProxy: ${err.message}`, {
          error: err.message,
          stack: err.stack,
        });
        return false;
      }
    } catch (err) {
      logger.error(`Certificate sync to HAProxy failed: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return false;
    }
  }

  /**
   * Check if HAProxy directories exist
   * @private
   */
  async _checkHAProxyDirs() {
    try {
      // Check if haproxy container is running
      execSync("docker ps | grep haproxy");
      return true;
    } catch (err) {
      logger.warn("HAProxy container not found or not running");
      return false;
    }
  }

  /**
   * Copy file to HAProxy container
   * @param {string} srcPath - Source file path
   * @param {string} destPath - Destination path in HAProxy container
   * @private
   */
  async _copyToHAProxyDir(srcPath, destPath) {
    try {
      const content = await fs.readFile(srcPath);
      const tempPath = `/tmp/${path.basename(srcPath)}`;
      await fs.writeFile(tempPath, content);
      execSync(`docker cp ${tempPath} haproxy:${destPath}`);
      execSync(`rm ${tempPath}`);

      // Ensure proper permissions
      execSync(`docker exec haproxy chmod 644 ${destPath}`);

      logger.debug(`Copied ${srcPath} to HAProxy at ${destPath}`);
      return true;
    } catch (err) {
      logger.error(`Failed to copy ${srcPath} to HAProxy: ${err.message}`);
      throw err;
    }
  }

  /**
   * Validate certificate setup for an agent
   * @param {string} agentId - The agent ID
   */
  async validateCertificateSetup(agentId) {
    logger.info(`Validating certificate setup for agent ${agentId}`);

    try {
      const result = {
        success: true,
        issues: [],
        certificate: {
          exists: false,
          expired: false,
          valid: false,
        },
        haproxy: {
          singleCertExists: false,
          agentCertExists: false,
          backendExists: false,
        },
      };

      // Check if certificate exists in Node.js app
      const agentDir = path.join(this.agentsDir, agentId);
      const serverCertPath = path.join(agentDir, "server.crt");
      const serverKeyPath = path.join(agentDir, "server.key");

      try {
        await fs.access(serverCertPath);
        await fs.access(serverKeyPath);
        result.certificate.exists = true;
      } catch (err) {
        result.success = false;
        result.issues.push("Certificate files not found for agent");
        return result;
      }

      // Check certificate validity
      try {
        const certInfo = execSync(
          `openssl x509 -in "${serverCertPath}" -noout -text`,
          { encoding: "utf8" }
        );

        // Check if certificate is expired
        const dates = execSync(
          `openssl x509 -in "${serverCertPath}" -noout -dates`,
          { encoding: "utf8" }
        );
        const afterMatch = dates.match(/notAfter=(.+)$/m);

        if (afterMatch) {
          const expiryDate = new Date(afterMatch[1]);
          const now = new Date();

          if (expiryDate <= now) {
            result.certificate.expired = true;
            result.success = false;
            result.issues.push("Certificate is expired");
          } else {
            // Check if expiring soon (30 days)
            const thirtyDaysFromNow = new Date();
            thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

            if (expiryDate <= thirtyDaysFromNow) {
              result.issues.push(
                "Certificate is expiring soon (within 30 days)"
              );
            }
          }
        }

        // Validate certificate for agent ID
        const subjectCN = certInfo.match(/Subject:.*CN\s*=\s*([^,\n]+)/);
        if (subjectCN && subjectCN[1] !== agentId) {
          result.success = false;
          result.issues.push(
            `Certificate CN (${subjectCN[1]}) does not match agent ID (${agentId})`
          );
        } else {
          result.certificate.valid = true;
        }
      } catch (err) {
        result.success = false;
        result.issues.push(`Failed to validate certificate: ${err.message}`);
      }

      // Check if certificate exists in HAProxy
      if (await this._checkHAProxyDirs()) {
        try {
          execSync(
            `docker exec haproxy test -f ${this.haproxyPrivateDir}/${agentId}.pem`
          );
          result.haproxy.agentCertExists = true;
        } catch (err) {
          result.success = false;
          result.issues.push(
            "Certificate not found in HAProxy private directory"
          );
        }

        // Check HAProxy config for backend
        try {
          const haproxyConfig = execSync(
            `docker exec haproxy cat /usr/local/etc/haproxy/haproxy.cfg`,
            { encoding: "utf8" }
          );
          if (haproxyConfig.includes(`backend mongodb-${agentId}`)) {
            result.haproxy.backendExists = true;
          } else {
            result.success = false;
            result.issues.push("Backend configuration not found in HAProxy");
          }
        } catch (err) {
          result.success = false;
          result.issues.push(`Failed to check HAProxy config: ${err.message}`);
        }
      } else {
        result.issues.push("HAProxy container not found or not running");
      }

      return result;
    } catch (err) {
      logger.error(
        `Certificate validation error for ${agentId}: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
          agentId,
        }
      );

      throw err;
    }
  }

  /**
   * Run certificate renewal check
   * @param {Object} options - Renewal options
   * @param {boolean} options.forceRenewal - Force renewal regardless of expiry
   * @param {number} options.renewBeforeDays - Days before expiry to renew
   */
  async checkAndRenewCertificates(options = {}) {
    const { forceRenewal = false, renewBeforeDays = 30 } = options;

    logger.info(
      `Running certificate renewal check (force=${forceRenewal}, renewBeforeDays=${renewBeforeDays})`
    );

    try {
      const results = {
        checked: 0,
        renewed: 0,
        failed: 0,
        skipped: 0,
        details: [],
      };

      // Check CA certificate first
      try {
        await fs.access(this.caCertPath);
        const caInfo = execSync(
          `openssl x509 -in "${this.caCertPath}" -noout -dates`,
          { encoding: "utf8" }
        );
        const afterMatch = caInfo.match(/notAfter=(.+)$/m);

        if (afterMatch) {
          const expiryDate = new Date(afterMatch[1]);
          const now = new Date();
          const renewDate = new Date();
          renewDate.setDate(now.getDate() + renewBeforeDays);

          if (forceRenewal || expiryDate <= renewDate) {
            // CA is expiring soon or force renewal requested
            logger.info("CA certificate needs renewal");
            // CA renewal is complex and requires careful handling
            // This would require custom implementation based on your requirements
            results.details.push({
              type: "ca",
              renewed: false,
              message: "CA renewal requires manual intervention",
            });
            results.skipped++;
          } else {
            results.details.push({
              type: "ca",
              renewed: false,
              message: "CA certificate still valid",
            });
            results.checked++;
          }
        }
      } catch (err) {
        logger.error(`Failed to check CA certificate: ${err.message}`);
        results.failed++;
      }

      // Check agent certificates
      try {
        const agentDirs = await fs.readdir(this.agentsDir);

        for (const agentId of agentDirs) {
          const agentDir = path.join(this.agentsDir, agentId);
          const stat = await fs.stat(agentDir);

          if (!stat.isDirectory()) continue;

          const serverCertPath = path.join(agentDir, "server.crt");

          try {
            await fs.access(serverCertPath);
            results.checked++;

            const certInfo = execSync(
              `openssl x509 -in "${serverCertPath}" -noout -dates`,
              { encoding: "utf8" }
            );
            const afterMatch = certInfo.match(/notAfter=(.+)$/m);

            if (afterMatch) {
              const expiryDate = new Date(afterMatch[1]);
              const now = new Date();
              const renewDate = new Date();
              renewDate.setDate(now.getDate() + renewBeforeDays);

              if (forceRenewal || expiryDate <= renewDate) {
                // Certificate is expiring soon or force renewal requested
                logger.info(`Certificate for agent ${agentId} needs renewal`);

                // Get target IP from subject alternative name
                const sanInfo = execSync(
                  `openssl x509 -in "${serverCertPath}" -noout -text | grep -A1 "Subject Alternative Name"`,
                  { encoding: "utf8" }
                );
                const ipMatch = sanInfo.match(/IP Address:([0-9.]+)/);
                const targetIp = ipMatch ? ipMatch[1] : "127.0.0.1";

                // Regenerate certificate
                const renewResult = await this.generateAgentCertificate(
                  agentId,
                  targetIp
                );

                if (renewResult.success) {
                  results.renewed++;
                  results.details.push({
                    type: "agent",
                    agentId,
                    renewed: true,
                    message: `Certificate renewed successfully`,
                  });
                } else {
                  results.failed++;
                  results.details.push({
                    type: "agent",
                    agentId,
                    renewed: false,
                    message: `Renewal failed: ${renewResult.error}`,
                  });
                }
              } else {
                results.details.push({
                  type: "agent",
                  agentId,
                  renewed: false,
                  message: "Certificate still valid",
                });
              }
            }
          } catch (err) {
            logger.error(
              `Failed to check certificate for agent ${agentId}: ${err.message}`
            );
            results.failed++;
            results.details.push({
              type: "agent",
              agentId,
              renewed: false,
              message: `Check failed: ${err.message}`,
            });
          }
        }
      } catch (err) {
        logger.error(`Failed to process agent directories: ${err.message}`);
      }

      // Make sure HAProxy has the latest certificates
      await this.syncCertificatesToHAProxy();

      logger.info(
        `Certificate renewal check completed: ${results.checked} checked, ${results.renewed} renewed, ${results.failed} failed, ${results.skipped} skipped`
      );

      return results;
    } catch (err) {
      logger.error(`Certificate renewal check failed: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });

      throw err;
    }
  }
}

module.exports = new CertificateManagerService();
