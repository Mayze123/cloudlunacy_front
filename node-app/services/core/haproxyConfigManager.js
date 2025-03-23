/**
 * HAProxy Configuration Manager
 *
 * Provides a structured and validated approach to managing HAProxy configuration
 * with proper error handling and rollback capabilities.
 */

const fs = require("fs").promises;
const path = require("path");
const YAML = require("yaml");
const logger = require("../../utils/logger").getLogger("haproxyConfigManager");
const { AppError } = require("../../utils/errorHandler");
const pathManager = require("../../utils/pathManager");

class HAProxyConfigManager {
  constructor() {
    this.initialized = false;
    this.configPath = null;
    this.backupDir = null;
    this.haproxyContainer = process.env.HAPROXY_CONTAINER || "haproxy";
    this.configCache = null;
    this.lastBackupPath = null;
    this._initializing = false;
  }

  /**
   * Initialize the HAProxy config manager
   */
  async initialize() {
    // Prevent re-initialization and circular dependencies
    if (this.initialized || this._initializing) {
      return this.initialized;
    }

    this._initializing = true;
    logger.info("Initializing HAProxy config manager");

    try {
      // Initialize path manager if needed
      if (!pathManager.initialized) {
        await pathManager.initialize();
      }

      // Set paths from path manager
      this.configPath = pathManager.getPath("haproxyConfig");
      this.backupDir = pathManager.getPath("configBackups");

      // Ensure backup directory exists
      await fs.mkdir(this.backupDir, { recursive: true });

      // Initial load of config without recursively calling initialize
      try {
        logger.debug(`Loading HAProxy config from ${this.configPath}`);
        const content = await fs.readFile(this.configPath, "utf8");
        this.configCache = YAML.parse(content);
      } catch (err) {
        logger.warn(
          `Could not load HAProxy config: ${err.message}. Creating default.`
        );
        // Create a default config if loading fails
        this.configCache = this._createDefaultConfig();
      }

      this.initialized = true;
      this._initializing = false;
      logger.info("HAProxy config manager initialized successfully");
      return true;
    } catch (err) {
      this._initializing = false;
      logger.error(
        `Failed to initialize HAProxy config manager: ${err.message}`,
        {
          error: err.message,
          stack: err.stack,
        }
      );
      return false;
    }
  }

  /**
   * Load HAProxy configuration
   */
  async loadConfig() {
    // Skip initialization if already being initialized
    // This prevents circular dependencies in the initialization process
    if (!this.initialized && !this._initializing) {
      await this.initialize();
    }

    try {
      logger.debug(`Loading HAProxy config from ${this.configPath}`);
      const content = await fs.readFile(this.configPath, "utf8");

      // Parse the config - assuming YAML, but could be adapted for other formats
      this.configCache = YAML.parse(content);

      return this.configCache;
    } catch (err) {
      logger.error(`Failed to load HAProxy config: ${err.message}`);
      throw new AppError(`Failed to load HAProxy config: ${err.message}`, 500);
    }
  }

  /**
   * Save HAProxy configuration with validation and backup
   * @param {Object} config - Configuration object to save
   */
  async saveConfig(config) {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // Validate configuration before saving
      const validationResult = this.validateConfig(config);
      if (!validationResult.valid) {
        logger.error(
          `Invalid HAProxy configuration: ${validationResult.error}`
        );
        throw new AppError(
          `Invalid HAProxy configuration: ${validationResult.error}`,
          400
        );
      }

      // Create backup of current config
      await this.backupConfig();

      // Convert to YAML
      const content = YAML.stringify(config);

      // Write to file
      await fs.writeFile(this.configPath, content, "utf8");

      // Update cache
      this.configCache = config;

      logger.info("HAProxy configuration saved successfully");
      return true;
    } catch (err) {
      if (err instanceof AppError) {
        throw err;
      }
      logger.error(`Failed to save HAProxy config: ${err.message}`);
      throw new AppError(`Failed to save HAProxy config: ${err.message}`, 500);
    }
  }

  /**
   * Create a backup of the current configuration
   */
  async backupConfig() {
    try {
      // Generate backup filename with timestamp
      const timestamp = new Date().toISOString().replace(/:/g, "-");
      const backupPath = path.join(
        this.backupDir,
        `haproxy-config-${timestamp}.yaml`
      );

      // Copy current config to backup
      await fs.copyFile(this.configPath, backupPath);

      // Store the path of the last backup for possible rollback
      this.lastBackupPath = backupPath;

      logger.info(`Created HAProxy config backup at ${backupPath}`);
      return backupPath;
    } catch (err) {
      logger.error(`Failed to create HAProxy config backup: ${err.message}`);
      throw new AppError(`Failed to create config backup: ${err.message}`, 500);
    }
  }

  /**
   * Roll back to the last backup if something goes wrong
   */
  async rollback() {
    if (!this.lastBackupPath) {
      logger.warn("No backup available for rollback");
      return false;
    }

    try {
      logger.info(`Rolling back to backup: ${this.lastBackupPath}`);

      // Copy backup to config file
      await fs.copyFile(this.lastBackupPath, this.configPath);

      // Reload config
      await this.loadConfig();

      // Apply the configuration
      await this.applyConfig();

      logger.info("Rollback completed successfully");
      return true;
    } catch (err) {
      logger.error(`Rollback failed: ${err.message}`);
      throw new AppError(`Rollback failed: ${err.message}`, 500);
    }
  }

  /**
   * Apply the configuration to HAProxy
   */
  async applyConfig() {
    try {
      // Validate first
      const validationResult = await this.validateConfigFile();
      if (!validationResult.valid) {
        logger.error(
          `Invalid HAProxy configuration, cannot apply: ${validationResult.error}`
        );
        throw new AppError(
          `Invalid HAProxy configuration: ${validationResult.error}`,
          400
        );
      }

      // Reload HAProxy
      await this._reloadHAProxy();

      logger.info("HAProxy configuration applied successfully");
      return true;
    } catch (err) {
      logger.error(`Failed to apply HAProxy configuration: ${err.message}`);
      throw new AppError(`Failed to apply configuration: ${err.message}`, 500);
    }
  }

  /**
   * Validate HAProxy configuration object
   * @param {Object} config - Configuration object to validate
   * @returns {Object} Validation result { valid: boolean, error: string }
   */
  validateConfig(config) {
    try {
      // Check for required sections
      if (!config.global) {
        return { valid: false, error: "Missing global section" };
      }

      if (!config.defaults) {
        return { valid: false, error: "Missing defaults section" };
      }

      if (!config.frontends || Object.keys(config.frontends).length === 0) {
        return { valid: false, error: "No frontends defined" };
      }

      // Check HTTP and TCP frontends
      const httpFrontend = config.frontends["https-in"];
      if (!httpFrontend) {
        return { valid: false, error: "Missing https-in frontend" };
      }

      const tcpFrontend = config.frontends["tcp-in"];
      if (!tcpFrontend) {
        return { valid: false, error: "Missing tcp-in frontend" };
      }

      // Check for specific requirements
      // Add more validation rules as needed

      return { valid: true };
    } catch (err) {
      logger.error(`Config validation error: ${err.message}`);
      return { valid: false, error: err.message };
    }
  }

  /**
   * Validate HAProxy configuration file using HAProxy
   * @returns {Promise<Object>} Validation result { valid: boolean, error: string }
   */
  async validateConfigFile() {
    try {
      // Use the HAProxy binary to check configuration
      const { execAsync } = require("../../utils/exec");
      const _result = await execAsync(
        `docker exec ${this.haproxyContainer} haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg`
      );

      return { valid: true };
    } catch (err) {
      logger.error(`HAProxy configuration validation failed: ${err.message}`);
      return { valid: false, error: err.message };
    }
  }

  /**
   * Reload HAProxy configuration
   * @private
   */
  async _reloadHAProxy() {
    try {
      const { execAsync } = require("../../utils/exec");

      // Soft reload HAProxy if possible
      const _softReloadOutput = await execAsync(
        `docker exec ${this.haproxyContainer} haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg && ` +
          `docker kill -s HUP ${this.haproxyContainer}`
      );

      logger.info("HAProxy soft reload completed successfully");
      return true;
    } catch (err) {
      logger.error(`HAProxy soft reload failed: ${err.message}`);

      // Try hard restart if soft reload fails
      try {
        logger.warn("Attempting hard restart of HAProxy");
        const { execAsync } = require("../../utils/exec");
        await execAsync(`docker restart ${this.haproxyContainer}`);

        logger.info("HAProxy hard restart completed successfully");
        return true;
      } catch (restartErr) {
        logger.error(`HAProxy hard restart failed: ${restartErr.message}`);
        throw new AppError(
          `Failed to reload HAProxy: ${restartErr.message}`,
          500
        );
      }
    }
  }

  /**
   * Check if HAProxy is running and responsive
   * @returns {Promise<Object>} Health check result { healthy: boolean, message: string, details: Object }
   */
  async checkHealth() {
    try {
      const { execAsync } = require("../../utils/exec");
      const healthDetails = {
        configValid: false,
        containerRunning: false,
        statsPageAccessible: false,
        certsValid: false,
        tcpPortsListening: false,
      };

      // 1. Check if container is running
      try {
        const statusOutput = await execAsync(
          `docker inspect -f '{{.State.Running}}' ${this.haproxyContainer}`
        );
        healthDetails.containerRunning = statusOutput.trim() === "true";

        if (!healthDetails.containerRunning) {
          return {
            healthy: false,
            message: "HAProxy container is not running",
            details: healthDetails,
          };
        }
      } catch (err) {
        logger.warn(`HAProxy container check failed: ${err.message}`);
        return {
          healthy: false,
          message: `HAProxy container not found or not accessible: ${err.message}`,
          details: healthDetails,
        };
      }

      // 2. Check configuration validity
      try {
        await execAsync(
          `docker exec ${this.haproxyContainer} haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg`
        );
        healthDetails.configValid = true;
      } catch (err) {
        logger.error(`HAProxy configuration is invalid: ${err.message}`);
        return {
          healthy: false,
          message: `HAProxy configuration is invalid: ${err.message}`,
          details: healthDetails,
        };
      }

      // 3. Check if stats page is accessible (port 8081)
      try {
        const { default: axios } = await import("axios");
        await axios.get("http://localhost:8081/stats", {
          timeout: 2000,
          validateStatus: () => true, // Accept any status code
        });
        healthDetails.statsPageAccessible = true;
      } catch (err) {
        logger.warn(`HAProxy stats page not accessible: ${err.message}`);
        // This is not critical, continue with checks
      }

      // 4. Check if TLS certificates are valid and not expired
      try {
        const _fs = require("fs").promises;
        const certPath =
          process.env.CERTS_PATH || "/app/config/certs/default.crt";
        const { execAsync } = require("../../utils/exec");

        const certInfo = await execAsync(
          `openssl x509 -in ${certPath} -text -noout | grep "Not After"`
        );

        if (certInfo) {
          const expiryMatch = certInfo.match(/Not After\s*:\s*(.+)/);
          if (expiryMatch && expiryMatch[1]) {
            const expiryDate = new Date(expiryMatch[1]);
            const now = new Date();

            // Check if certificate is valid for at least 7 more days
            const sevenDaysInMs = 7 * 24 * 60 * 60 * 1000;
            healthDetails.certsValid = expiryDate - now > sevenDaysInMs;

            if (!healthDetails.certsValid) {
              logger.warn(
                `HAProxy TLS certificate will expire soon: ${expiryMatch[1]}`
              );
            }
          }
        }
      } catch (err) {
        logger.warn(`Could not check TLS certificates: ${err.message}`);
        // Not critical for health check
      }

      // 5. Check if required TCP ports are listening
      try {
        const portsToCheck = ["80", "443", "27017"];
        const netstat = await execAsync(
          `docker exec ${
            this.haproxyContainer
          } netstat -tuln | grep -E '${portsToCheck.join("|")}'`
        );

        const listeningPorts = portsToCheck.filter((port) =>
          netstat.includes(`:${port}`)
        );
        healthDetails.tcpPortsListening =
          listeningPorts.length === portsToCheck.length;

        if (!healthDetails.tcpPortsListening) {
          const missingPorts = portsToCheck.filter(
            (port) => !netstat.includes(`:${port}`)
          );
          logger.warn(
            `HAProxy not listening on ports: ${missingPorts.join(", ")}`
          );
        }
      } catch (err) {
        logger.warn(`Could not check TCP ports: ${err.message}`);
        // Not critical for overall health
      }

      // Determine overall health
      const isHealthy =
        healthDetails.containerRunning && healthDetails.configValid;

      return {
        healthy: isHealthy,
        message: isHealthy ? "HAProxy is healthy" : "HAProxy has issues",
        details: healthDetails,
      };
    } catch (err) {
      logger.error(`HAProxy health check failed: ${err.message}`);
      return {
        healthy: false,
        message: `HAProxy health check failed: ${err.message}`,
        details: { error: err.message },
      };
    }
  }

  /**
   * Add a backend to the configuration
   * @param {string} name - Backend name
   * @param {Object} options - Backend options
   */
  async addBackend(name, options) {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // Reload config to ensure we have the latest
      const config = await this.loadConfig();

      // Add or update backend
      config.backends = config.backends || {};
      config.backends[name] = options;

      // Save the updated configuration
      await this.saveConfig(config);

      logger.info(`Backend '${name}' added to HAProxy configuration`);
      return true;
    } catch (err) {
      logger.error(`Failed to add backend '${name}': ${err.message}`);
      throw err;
    }
  }

  /**
   * Add a frontend rule
   * @param {string} frontendName - Frontend name
   * @param {string} backendName - Backend to use
   * @param {string} condition - ACL condition
   * @param {string} aclName - ACL name
   */
  async addFrontendRule(frontendName, backendName, condition, aclName) {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // Reload config to ensure we have the latest
      const config = await this.loadConfig();

      // Ensure frontend exists
      if (!config.frontends || !config.frontends[frontendName]) {
        throw new AppError(`Frontend '${frontendName}' does not exist`, 400);
      }

      const frontend = config.frontends[frontendName];

      // Add or update ACL
      frontend.acls = frontend.acls || [];

      // Remove existing ACL if present
      frontend.acls = frontend.acls.filter((acl) => acl.name !== aclName);

      // Add new ACL
      frontend.acls.push({
        name: aclName,
        condition: condition,
      });

      // Add use_backend rule
      frontend.useBackends = frontend.useBackends || [];

      // Remove existing rule if present
      frontend.useBackends = frontend.useBackends.filter(
        (ub) => ub.backend !== backendName
      );

      // Add new rule
      frontend.useBackends.push({
        backend: backendName,
        condition: `if ${aclName}`,
      });

      // Save the updated configuration
      await this.saveConfig(config);

      logger.info(
        `Frontend rule added to '${frontendName}' for backend '${backendName}'`
      );
      return true;
    } catch (err) {
      logger.error(`Failed to add frontend rule: ${err.message}`);
      throw err;
    }
  }

  /**
   * Remove a backend and any related frontend rules
   * @param {string} backendName - Backend to remove
   */
  async removeBackend(backendName) {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // Reload config to ensure we have the latest
      const config = await this.loadConfig();

      // Check if backend exists
      if (!config.backends || !config.backends[backendName]) {
        logger.warn(
          `Backend '${backendName}' does not exist, nothing to remove`
        );
        return false;
      }

      // Remove the backend
      delete config.backends[backendName];

      // Remove any frontend rules that reference this backend
      if (config.frontends) {
        for (const frontendName in config.frontends) {
          const frontend = config.frontends[frontendName];

          if (frontend.useBackends) {
            frontend.useBackends = frontend.useBackends.filter(
              (ub) => ub.backend !== backendName
            );
          }
        }
      }

      // Save the updated configuration
      await this.saveConfig(config);

      logger.info(
        `Backend '${backendName}' removed from HAProxy configuration`
      );
      return true;
    } catch (err) {
      logger.error(`Failed to remove backend '${backendName}': ${err.message}`);
      throw err;
    }
  }

  /**
   * Create a default HAProxy configuration
   * @returns {Object} Default configuration object
   * @private
   */
  _createDefaultConfig() {
    logger.info("Creating default HAProxy configuration");
    return {
      global: {
        maxconn: 4096,
        user: "haproxy",
        group: "haproxy",
        daemon: true,
        stats: {
          socket:
            "/var/run/haproxy.sock mode 660 level admin expose-fd listeners",
          timeout: "30s",
        },
      },
      defaults: {
        log: "global",
        mode: "http",
        option: ["httplog", "dontlognull"],
        timeout: {
          connect: "5000ms",
          client: "50000ms",
          server: "50000ms",
        },
      },
      frontends: {
        "http-in": {
          bind: "*:80",
          mode: "http",
          default_backend: "node-app-backend",
        },
      },
      backends: {
        "node-app-backend": {
          mode: "http",
          server: "node-app node-app:3005 check",
        },
      },
    };
  }
}

module.exports = HAProxyConfigManager;
