/**
 * Path Manager
 *
 * Centralized utility for managing file paths throughout the application.
 * Provides a single source of truth for all path-related operations.
 */

const path = require("path");
const fs = require("fs").promises;
const fsSync = require("fs");
const logger = require("./logger").getLogger("pathManager");

class PathManager {
  constructor() {
    // Base paths - use volume-mounted directories by default
    this.basePaths = {
      app: process.env.APP_BASE_PATH || "/app",
      config: process.env.CONFIG_BASE_PATH || "/app/config",
      logs: process.env.LOGS_BASE_PATH || "/app/logs",
      certs: process.env.CERTS_BASE_PATH || "/app/config/certs",
      scripts: process.env.SCRIPTS_BASE_PATH || "/app/scripts",
      certbot: process.env.CERTBOT_BASE_PATH || "/app/config/certbot",
      // Use mounted volume instead of hardcoded path
      frontendRoot: process.env.FRONTEND_ROOT_PATH || "/opt/cloudlunacy_front",
    };

    // Derived paths
    this.derivedPaths = {
      // Config paths
      haproxyConfig: path.join(this.basePaths.config, "haproxy/haproxy.cfg"),
      agentsConfig: path.join(this.basePaths.config, "agents"),
      configBackups: path.join(this.basePaths.config, "backups"),
      dynamicConfig: path.join(this.basePaths.config, "dynamic-config.yaml"),

      // Certificate paths
      certsAgents: path.join(this.basePaths.certs, "agents"),
      caCert: path.join(this.basePaths.certs, "ca.crt"),
      caKey: path.join(this.basePaths.certs, "ca.key"),

      // Docker paths
      dockerSock: process.env.DOCKER_SOCK || "/var/run/docker.sock",
      dockerCompose:
        process.env.DOCKER_COMPOSE_PATH || "/app/docker-compose.yml",
    };

    // External paths (outside container)
    this.externalPaths = {
      haproxyConfig:
        process.env.EXTERNAL_HAPROXY_CONFIG || "/app/config/haproxy",
      haproxyCerts:
        process.env.EXTERNAL_HAPROXY_CERTS || "/config/haproxy/certs",
      haproxyLogs: process.env.EXTERNAL_HAPROXY_LOGS || "/var/log/haproxy",
    };

    // Initialize path resolution status
    this.initialized = false;

    // Flag to track permission issues
    this.permissionIssues = false;
  }

  /**
   * Initialize the path manager
   * Resolves and validates critical paths
   */
  async initialize() {
    try {
      logger.info("Initializing path manager");

      // Test if frontendRoot is writable, otherwise switch to app path
      if (!(await this.isWritable(this.basePaths.frontendRoot))) {
        logger.warn(
          `Frontend root path ${this.basePaths.frontendRoot} is not writable, using app path instead`
        );
        this.basePaths.frontendRoot = this.basePaths.app;
        this.permissionIssues = true;
      }

      // Ensure critical directories exist with fallbacks if needed
      await this.ensureDirectoriesWithFallbacks([
        {
          primary: this.basePaths.config,
          fallback: path.join(this.basePaths.frontendRoot, "config"),
        },
        {
          primary: this.basePaths.logs,
          fallback: path.join(this.basePaths.frontendRoot, "logs"),
        },
        {
          primary: this.basePaths.certs,
          fallback: path.join(this.basePaths.frontendRoot, "config/certs"),
        },
        {
          primary: this.derivedPaths.certsAgents,
          fallback: path.join(
            this.basePaths.frontendRoot,
            "config/certs/agents"
          ),
        },
        {
          primary: this.derivedPaths.agentsConfig,
          fallback: path.join(this.basePaths.frontendRoot, "config/agents"),
        },
        {
          primary: this.derivedPaths.configBackups,
          fallback: path.join(this.basePaths.frontendRoot, "backups"),
        },
      ]);

      this.initialized = true;
      logger.info("Path manager initialized successfully");
      return true;
    } catch (err) {
      logger.error(`Failed to initialize path manager: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      // Even if initialization fails, we'll continue with default paths
      // to allow the application to work with limited functionality
      this.initialized = true;
      this.permissionIssues = true;
      return false;
    }
  }

  /**
   * Ensure directories exist with fallbacks if primary fails
   * @param {Array<Object>} directoryConfigs - Array of {primary, fallback} paths
   */
  async ensureDirectoriesWithFallbacks(directoryConfigs) {
    for (const config of directoryConfigs) {
      try {
        // First try to create the primary directory
        await this.ensureDirectory(config.primary);
      } catch (err) {
        logger.warn(
          `Failed to ensure primary directory ${config.primary}: ${err.message}`
        );

        if (config.fallback) {
          try {
            // Try the fallback directory
            await this.ensureDirectory(config.fallback);

            // Update the corresponding path in our config
            this.updatePathToFallback(config.primary, config.fallback);
            logger.info(
              `Using fallback directory ${config.fallback} instead of ${config.primary}`
            );
          } catch (fallbackErr) {
            logger.error(
              `Failed to ensure fallback directory ${config.fallback}: ${fallbackErr.message}`
            );
            // Mark that we have permission issues but don't throw
            this.permissionIssues = true;
          }
        } else {
          logger.error(
            `No fallback directory configured for ${config.primary}`
          );
          this.permissionIssues = true;
        }
      }
    }
    return true;
  }

  /**
   * Update a path in all collections to use fallback
   * @param {string} originalPath - The original path that failed
   * @param {string} fallbackPath - The fallback path to use instead
   */
  updatePathToFallback(originalPath, fallbackPath) {
    // Update in basePaths
    for (const [key, value] of Object.entries(this.basePaths)) {
      if (value === originalPath) {
        this.basePaths[key] = fallbackPath;
      }
    }

    // Update in derivedPaths
    for (const [key, value] of Object.entries(this.derivedPaths)) {
      if (value === originalPath) {
        this.derivedPaths[key] = fallbackPath;
      } else if (value.startsWith(originalPath + "/")) {
        // Handle nested paths
        const relativePath = value.substring(originalPath.length);
        this.derivedPaths[key] = path.join(fallbackPath, relativePath);
      }
    }

    // Update in externalPaths
    for (const [key, value] of Object.entries(this.externalPaths)) {
      if (value === originalPath) {
        this.externalPaths[key] = fallbackPath;
      }
    }
  }

  /**
   * Ensure directories exist, creating them if necessary
   * @param {Array<string>} directories - Array of directory paths to ensure
   */
  async ensureDirectories(directories) {
    for (const dir of directories) {
      try {
        await this.ensureDirectory(dir);
      } catch (err) {
        logger.error(`Failed to create directory ${dir}: ${err.message}`);
        throw err;
      }
    }
    return true;
  }

  /**
   * Get a path by its key
   * @param {string} pathKey - The key of the path to retrieve
   * @returns {string} The resolved path
   */
  getPath(pathKey) {
    // Check base paths
    if (this.basePaths[pathKey]) {
      return this.basePaths[pathKey];
    }

    // Check derived paths
    if (this.derivedPaths[pathKey]) {
      return this.derivedPaths[pathKey];
    }

    // Check external paths
    if (this.externalPaths[pathKey]) {
      return this.externalPaths[pathKey];
    }

    logger.warn(`Unknown path key: ${pathKey}`);
    return null;
  }

  /**
   * Resolve a path relative to a base path
   * @param {string} basePath - The base path key or actual path
   * @param {string} relativePath - The relative path to append
   * @returns {string} The resolved path
   */
  resolvePath(basePath, relativePath) {
    // If basePath is a key, get the actual path
    const base = this.getPath(basePath) || basePath;
    return path.join(base, relativePath);
  }

  /**
   * Resolve a path based on environment and availability
   * Similar to the old pathResolver.resolvePath but using our centralized approach
   * @param {string} relativePath - The relative path to resolve
   * @param {Array<string>} basePaths - Potential base paths to check
   * @returns {Promise<string>} - The resolved absolute path
   */
  async resolvePathWithFallbacks(relativePath, basePaths = []) {
    // Default base paths to check
    const defaultBasePaths = [
      this.basePaths.app,
      this.basePaths.config,
      "/opt/cloudlunacy_front",
      "/opt/cloudlunacy_front/node-app",
      process.cwd(),
    ];

    // Combine with provided base paths
    const allBasePaths = [...basePaths, ...defaultBasePaths];

    // Try each base path
    for (const basePath of allBasePaths) {
      const fullPath = path.join(basePath, relativePath);
      if (await this.pathExists(fullPath)) {
        logger.debug(`Resolved path ${relativePath} to ${fullPath}`);
        return fullPath;
      }
    }

    // If we get here, no valid path was found
    logger.warn(`Could not resolve path: ${relativePath}`);

    // Return the default path as fallback
    const defaultPath = path.join(defaultBasePaths[0], relativePath);
    logger.debug(`Using default path: ${defaultPath}`);
    return defaultPath;
  }

  /**
   * Check if a path exists
   * @param {string} pathToCheck - The path to check
   * @returns {Promise<boolean>} Whether the path exists
   */
  async pathExists(pathToCheck) {
    try {
      await fs.access(pathToCheck);
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Ensure a directory exists, creating it if necessary
   * @param {string} dirPath - The directory path to ensure
   * @returns {Promise<boolean>} - True if directory exists or was created
   */
  async ensureDirectory(dirPath) {
    try {
      await fs.access(dirPath);
      return true;
    } catch (_) {
      try {
        await fs.mkdir(dirPath, { recursive: true });
        logger.info(`Created directory: ${dirPath}`);
        return true;
      } catch (mkdirErr) {
        logger.error(
          `Failed to create directory ${dirPath}: ${mkdirErr.message}`
        );
        throw mkdirErr;
      }
    }
  }

  /**
   * Check if a path is writable
   * @param {string} filePath - The path to check
   * @returns {Promise<boolean>} - True if path is writable
   */
  async isWritable(filePath) {
    try {
      // First check if path exists
      try {
        await fs.access(filePath);
      } catch (err) {
        // Try to create the directory
        try {
          await fs.mkdir(filePath, { recursive: true });
        } catch (mkdirErr) {
          return false;
        }
      }

      // Try to write a temporary file
      const testPath = path.join(
        path.dirname(filePath),
        `.write-test-${Date.now()}`
      );
      await fs.writeFile(testPath, "test");
      await fs.unlink(testPath);
      return true;
    } catch (err) {
      logger.warn(`Path ${filePath} is not writable: ${err.message}`);
      return false;
    }
  }

  /**
   * Get all paths as a flat object (for debugging)
   * @returns {Object} All paths
   */
  getAllPaths() {
    return {
      ...this.basePaths,
      ...this.derivedPaths,
      ...this.externalPaths,
    };
  }

  /**
   * Resolve the path for dynamic configuration
   * @returns {string} Path to dynamic configuration file
   */
  resolveDynamicConfigPath() {
    // Default to HAProxy config path
    return this.derivedPaths.haproxyConfig;
  }

  /**
   * Resolve the base path
   * @returns {string} Base path
   */
  resolveBasePath() {
    return this.basePaths.config;
  }

  /**
   * Resolve the config path
   * @returns {string} Config path
   */
  resolveConfigPath() {
    return this.basePaths.config;
  }

  /**
   * Resolve the agents config path
   * @returns {string} Agents config path
   */
  resolveAgentsPath() {
    return this.derivedPaths.agentsConfig;
  }

  /**
   * Resolve the docker compose path
   * @returns {string} Docker compose path
   */
  resolveDockerComposePath() {
    return this.derivedPaths.dockerCompose;
  }
}

// Export a singleton instance
module.exports = new PathManager();
