/**
 * HAProxy Configuration Manager
 *
 * Provides a structured and validated approach to managing HAProxy configuration
 * with proper error handling and rollback capabilities.
 */

const fs = require("fs").promises;
const path = require("path");
const logger = require("../../utils/logger").getLogger("haproxyConfigManager");
const { AppError } = require("../../utils/errorHandler");
const pathManager = require("../../utils/pathManager");
const { execAsync } = require("../../utils/exec");
const Mustache = require("mustache");

class HAProxyConfigManager {
  constructor() {
    this.initialized = false;
    this.configPath = null;
    this.backupDir = null;
    this.templatePath = null;
    this.haproxyContainer = process.env.HAPROXY_CONTAINER || "haproxy";
    this.configCache = null;
    this.lastBackupPath = null;
    this._initializing = false;
    this.retry = {
      maxAttempts: 3,
      delay: 1000, // ms
    };
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
      this.templatePath = pathManager.getPath(
        "haproxyTemplates",
        "templates/haproxy"
      );

      // Ensure backup directory exists
      await fs.mkdir(this.backupDir, { recursive: true });

      // Ensure template directory exists
      await fs.mkdir(this.templatePath, { recursive: true });

      // Initialize templates if they don't exist
      await this._ensureTemplatesExist();

      // Initial load of config without recursively calling initialize
      try {
        logger.debug(`Loading HAProxy config from ${this.configPath}`);
        const content = await fs.readFile(this.configPath, "utf8");
        this.configCache = content;
      } catch (loadErr) {
        logger.warn(
          `Could not load HAProxy config: ${loadErr.message}. Creating default.`
        );
        // Create a default config if loading fails
        this.configCache = await this._generateDefaultConfig();
        // Write it to disk
        await fs.writeFile(this.configPath, this.configCache, "utf8");
      }

      // Validate the config
      const validation = await this.validateConfigFile(this.configPath);
      if (!validation.valid) {
        logger.warn(
          `Existing HAProxy config is invalid: ${validation.error}. Creating default.`
        );
        this.configCache = await this._generateDefaultConfig();
        await fs.writeFile(this.configPath, this.configCache, "utf8");
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
   * Ensure all necessary template files exist
   */
  async _ensureTemplatesExist() {
    const templateFiles = [
      "base.cfg.mustache",
      "frontend_http.cfg.mustache",
      "backend_http.cfg.mustache",
      "frontend_mongodb.cfg.mustache",
      "backend_mongodb.cfg.mustache",
      "server_entry.cfg.mustache",
      "stats.cfg.mustache",
    ];

    for (const file of templateFiles) {
      const filePath = path.join(this.templatePath, file);
      try {
        await fs.access(filePath);
      } catch (fileErr) {
        // File doesn't exist, create default template
        await this._createDefaultTemplate(file);
      }
    }
  }

  /**
   * Create a default template file
   * @param {string} fileName - Template file name
   */
  async _createDefaultTemplate(fileName) {
    const filePath = path.join(this.templatePath, fileName);
    let content = "";

    switch (fileName) {
      case "base.cfg.mustache":
        content = `# HAProxy Configuration for CloudLunacy Front Server
global
    log stdout format raw local0 info
    log stderr format raw local1 notice
    stats socket /tmp/haproxy.sock mode 660 level admin expose-fd listeners
    stats timeout 30s
    user haproxy
    group haproxy
    daemon
    maxconn 20000
    
    # Enable runtime API
    stats socket ipv4@127.0.0.1:9999 level admin
    stats timeout 2m

defaults
    log global
    mode http
    option httplog
    option dontlognull
    timeout connect 5000ms
    timeout client 50000ms
    timeout server 50000ms

{{{stats}}}

{{{frontends}}}

{{{backends}}}
`;
        break;
      case "frontend_http.cfg.mustache":
        content = `# Frontend for HTTP traffic
frontend http-in
    bind *:80
    mode http
    option forwardfor
    default_backend node-app-backend
`;
        break;
      case "backend_http.cfg.mustache":
        content = `# Backend for Node.js app
backend node-app-backend
    mode http
    option httpchk GET /health
    http-check expect status 200
    server node_app node-app:3005 check inter 5s rise 2 fall 3
`;
        break;
      case "frontend_mongodb.cfg.mustache":
        content = `# MongoDB Frontend with TLS and SNI support
frontend mongodb_frontend
{{#useSsl}}
    bind *:27017 ssl crt {{{sslCertPath}}}
    # Extract the agent ID from the SNI hostname for routing
    http-request set-var(txn.agent_id) req.ssl_sni,field(1,'.')
{{/useSsl}}
{{^useSsl}}
    bind *:27017
    # SSL temporarily disabled
{{/useSsl}}
    mode tcp
    option tcplog
    
    # Add enhanced logging for debugging
    log-format "%ci:%cp [%t] %ft %b/%s %Tw/%Tc/%Tt %B %ts %ac/%fc/%bc/%sc/%rc %sq/%bq"
    
    default_backend mongodb_default
`;
        break;
      case "backend_mongodb.cfg.mustache":
        content = `# MongoDB Backend
backend mongodb_default
    mode tcp
    balance roundrobin
{{#servers}}
    {{{.}}}
{{/servers}}
`;
        break;
      case "server_entry.cfg.mustache":
        content = `server {{name}} {{address}}:{{port}} check`;
        break;
      case "stats.cfg.mustache":
        content = `# Stats page
frontend stats
    bind *:8081
    stats enable
    stats uri /stats
    stats refresh 10s
    stats auth admin:{{statsPassword}}
    stats admin if TRUE
`;
        break;
    }

    // Create the template file
    await fs.writeFile(filePath, content, "utf8");
    logger.info(`Created default template: ${filePath}`);
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
      this.configCache = content;
      return content;
    } catch (err) {
      logger.error(`Failed to load HAProxy config: ${err.message}`);
      throw new AppError(`Failed to load HAProxy config: ${err.message}`, 500);
    }
  }

  /**
   * Save HAProxy configuration with validation and backup
   * @param {Object} configData - Configuration data object
   */
  async saveConfig(configData) {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // Generate config from templates using the data
      const config = await this._generateConfigFromTemplates(configData);

      // Create temporary file for validation
      const tempPath = path.join(this.backupDir, "temp_config.cfg");
      await fs.writeFile(tempPath, config, "utf8");

      // Validate configuration before saving
      const validationResult = await this.validateConfigFile(tempPath);
      if (!validationResult.valid) {
        logger.error(
          `Invalid HAProxy configuration: ${validationResult.error}`
        );
        // Clean up temp file
        await fs.unlink(tempPath);
        throw new AppError(
          `Invalid HAProxy configuration: ${validationResult.error}`,
          400
        );
      }

      // Clean up temp file
      await fs.unlink(tempPath);

      // Create backup of current config
      await this.backupConfig();

      // Write to file
      await fs.writeFile(this.configPath, config, "utf8");

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
   * Generate configuration from templates
   * @param {Object} data - Configuration data
   * @returns {Promise<string>} Generated configuration
   */
  async _generateConfigFromTemplates(data) {
    // Load template files
    const baseTemplate = await fs.readFile(
      path.join(this.templatePath, "base.cfg.mustache"),
      "utf8"
    );

    const statsTemplate = await fs.readFile(
      path.join(this.templatePath, "stats.cfg.mustache"),
      "utf8"
    );

    // Render stats
    const statsData = {
      statsPassword: data.statsPassword || "admin_password",
    };
    const statsContent = Mustache.render(statsTemplate, statsData);

    // Process frontends
    let frontends = "";

    // Add HTTP frontend
    if (data.includeHttp !== false) {
      const httpFrontendTemplate = await fs.readFile(
        path.join(this.templatePath, "frontend_http.cfg.mustache"),
        "utf8"
      );
      frontends += Mustache.render(httpFrontendTemplate, data) + "\n";
    }

    // Add MongoDB frontend if requested
    if (data.includeMongoDB === true) {
      const mongoFrontendTemplate = await fs.readFile(
        path.join(this.templatePath, "frontend_mongodb.cfg.mustache"),
        "utf8"
      );

      const mongoFrontendData = {
        useSsl: data.useSsl || false,
        sslCertPath: data.sslCertPath || "/etc/ssl/certs/mongodb.pem",
      };

      frontends +=
        Mustache.render(mongoFrontendTemplate, mongoFrontendData) + "\n";
    }

    // Process backends
    let backends = "";

    // Add HTTP backend
    if (data.includeHttp !== false) {
      const httpBackendTemplate = await fs.readFile(
        path.join(this.templatePath, "backend_http.cfg.mustache"),
        "utf8"
      );
      backends += Mustache.render(httpBackendTemplate, data) + "\n";
    }

    // Add MongoDB backend if requested
    if (data.includeMongoDB === true) {
      const mongoBackendTemplate = await fs.readFile(
        path.join(this.templatePath, "backend_mongodb.cfg.mustache"),
        "utf8"
      );

      // Process MongoDB servers
      const serverEntryTemplate = await fs.readFile(
        path.join(this.templatePath, "server_entry.cfg.mustache"),
        "utf8"
      );

      const serverEntries = [];
      if (data.mongoDBServers && Array.isArray(data.mongoDBServers)) {
        for (const server of data.mongoDBServers) {
          const serverEntry = Mustache.render(serverEntryTemplate, server);
          serverEntries.push(serverEntry);
        }
      }

      const mongoBackendData = {
        servers: serverEntries,
      };

      backends +=
        Mustache.render(mongoBackendTemplate, mongoBackendData) + "\n";
    }

    // Render the full config
    const fullConfigData = {
      stats: statsContent,
      frontends: frontends,
      backends: backends,
    };

    return Mustache.render(baseTemplate, fullConfigData);
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
        `haproxy-config-${timestamp}.cfg`
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

      // Apply the configuration with retries
      await this._applyConfigWithRetries();

      logger.info("Rollback completed successfully");
      return true;
    } catch (err) {
      logger.error(`Rollback failed: ${err.message}`);
      throw new AppError(`Rollback failed: ${err.message}`, 500);
    }
  }

  /**
   * Apply the configuration to HAProxy with retries
   */
  async _applyConfigWithRetries(attempts = 0) {
    try {
      // Validate first
      const validationResult = await this.validateConfigFile(this.configPath);
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
      if (attempts < this.retry.maxAttempts) {
        logger.warn(
          `Failed to apply HAProxy configuration, retrying (${attempts + 1}/${
            this.retry.maxAttempts
          }): ${err.message}`
        );

        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, this.retry.delay));

        // Retry with incremented attempts
        return this._applyConfigWithRetries(attempts + 1);
      }

      logger.error(
        `Failed to apply HAProxy configuration after ${this.retry.maxAttempts} attempts: ${err.message}`
      );
      throw new AppError(`Failed to apply configuration: ${err.message}`, 500);
    }
  }

  /**
   * Apply the configuration to HAProxy
   */
  async applyConfig() {
    return this._applyConfigWithRetries();
  }

  /**
   * Validate HAProxy configuration file
   * @param {string} configPath - Path to configuration file to validate
   * @returns {Object} Validation result { valid: boolean, error: string }
   */
  async validateConfigFile(configPath) {
    try {
      // Use HAProxy's built-in config check function
      const { stdout, stderr } = await execAsync(
        `docker exec ${this.haproxyContainer} haproxy -c -f ${configPath}`
      );

      // Check for validation messages in stderr/stdout
      if (
        stderr.includes("Configuration file is valid") ||
        stdout.includes("Configuration file is valid")
      ) {
        return { valid: true };
      } else {
        // Extract error message
        const errorMatch = (stderr || stdout).match(/\[\w+\]\s+(.+)/);
        const errorMsg = errorMatch
          ? errorMatch[1]
          : "Unknown validation error";
        return { valid: false, error: errorMsg };
      }
    } catch (err) {
      // Extract error message from command output if possible
      let errorMsg = err.message;
      if (err.stderr) {
        const errorMatch = err.stderr.match(/\[\w+\]\s+(.+)/);
        errorMsg = errorMatch ? errorMatch[1] : err.stderr;
      }
      return { valid: false, error: errorMsg };
    }
  }

  /**
   * Reload HAProxy with new configuration
   */
  async _reloadHAProxy() {
    try {
      logger.info("Reloading HAProxy configuration");

      // First validate config
      const { stdout, stderr } = await execAsync(
        `docker exec ${this.haproxyContainer} haproxy -c -f ${this.haproxyConfigPath}`
      );

      if (stderr.includes("error") || stdout.includes("error")) {
        throw new Error(`Invalid HAProxy configuration: ${stderr || stdout}`);
      }

      // Then reload
      await execAsync(`docker kill -s HUP ${this.haproxyContainer}`);

      logger.info("HAProxy configuration reloaded successfully");
      return true;
    } catch (err) {
      logger.error(`Failed to reload HAProxy: ${err.message}`);
      throw err;
    }
  }

  /**
   * Generate default HAProxy configuration as string
   * @returns {Promise<string>} Default configuration
   */
  async _generateDefaultConfig() {
    // Use the template system to generate a default config
    const defaultData = {
      statsPassword: "admin_password",
      includeHttp: true,
      includeMongoDB: false, // Don't include MongoDB by default
      useSsl: false,
    };

    return this._generateConfigFromTemplates(defaultData);
  }

  /**
   * Add a MongoDB server to the configuration
   * @param {string} agentId - Agent ID
   * @param {string} address - Server address
   * @param {number} port - Server port
   * @returns {Promise<boolean>} Success
   */
  async addMongoDBServer(agentId, address, port) {
    try {
      // Load current config
      await this.loadConfig();

      // Get the MongoDB servers from the current config
      // This is a simplified approach - in a real system you'd want to
      // parse the existing config or maintain server state in a database
      const mongoServer = {
        name: `mongodb-agent-${agentId}`,
        address: address,
        port: port,
      };

      // Existing MongoDB servers (would need to parse from config or from DB)
      const mongoDBServers = [];

      // Check if this server already exists, and update it if so
      const existingServerIndex = mongoDBServers.findIndex(
        (s) => s.name === mongoServer.name
      );
      if (existingServerIndex !== -1) {
        mongoDBServers[existingServerIndex] = mongoServer;
      } else {
        mongoDBServers.push(mongoServer);
      }

      // Generate new config
      const configData = {
        statsPassword: "admin_password",
        includeHttp: true,
        includeMongoDB: true,
        useSsl: false, // Set based on SSL certificate availability
        mongoDBServers,
      };

      // Check if SSL cert exists
      try {
        await fs.access("/etc/ssl/certs/mongodb.pem");
        configData.useSsl = true;
        configData.sslCertPath = "/etc/ssl/certs/mongodb.pem";
      } catch (certErr) {
        logger.warn("MongoDB SSL certificate not found, disabling SSL");
      }

      // Save and apply the new config
      await this.saveConfig(configData);
      await this.applyConfig();

      return true;
    } catch (err) {
      logger.error(`Failed to add MongoDB server: ${err.message}`);
      throw new AppError(`Failed to add MongoDB server: ${err.message}`, 500);
    }
  }

  /**
   * Remove a MongoDB server from the configuration
   * @param {string} agentId - Agent ID
   * @returns {Promise<boolean>} Success
   */
  async removeMongoDBServer(agentId) {
    try {
      // Load current config
      await this.loadConfig();

      // Existing MongoDB servers (would need to parse from config or from DB)
      const mongoDBServers = [];

      // Filter out the server to remove
      const updatedServers = mongoDBServers.filter(
        (s) => s.name !== `mongodb-agent-${agentId}`
      );

      // Generate new config
      const configData = {
        statsPassword: "admin_password",
        includeHttp: true,
        includeMongoDB: updatedServers.length > 0, // Only include MongoDB section if we have servers
        useSsl: false,
        mongoDBServers: updatedServers,
      };

      // Check if SSL cert exists
      try {
        await fs.access("/etc/ssl/certs/mongodb.pem");
        configData.useSsl = true;
        configData.sslCertPath = "/etc/ssl/certs/mongodb.pem";
      } catch (certErr) {
        // No SSL certificate available
        logger.debug("No SSL certificate found during server removal");
      }

      // Save and apply the new config
      await this.saveConfig(configData);
      await this.applyConfig();

      return true;
    } catch (err) {
      logger.error(`Failed to remove MongoDB server: ${err.message}`);
      throw new AppError(
        `Failed to remove MongoDB server: ${err.message}`,
        500
      );
    }
  }

  /**
   * Check for HAProxy health status
   * @returns {Promise<Object>} Health status
   */
  async checkHealth() {
    try {
      // Check if HAProxy is running
      const { stdout } = await execAsync(
        `docker ps -q -f name=${this.haproxyContainer}`
      );

      if (!stdout.trim()) {
        return {
          healthy: false,
          status: "not_running",
          message: "HAProxy container is not running",
        };
      }

      // Check if HAProxy is accepting connections
      try {
        await execAsync(
          `docker exec ${this.haproxyContainer} bash -c "echo 'show info' | socat stdio /tmp/haproxy.sock"`
        );

        return {
          healthy: true,
          status: "running",
          message: "HAProxy is running and responding",
        };
      } catch (socketErr) {
        return {
          healthy: false,
          status: "not_responding",
          message:
            "HAProxy container is running but not responding to socket commands",
          error: socketErr.message,
        };
      }
    } catch (err) {
      logger.error(`Failed to check HAProxy health: ${err.message}`);
      return {
        healthy: false,
        status: "check_failed",
        message: `Failed to check HAProxy health: ${err.message}`,
        error: err.message,
      };
    }
  }
}

module.exports = HAProxyConfigManager;
