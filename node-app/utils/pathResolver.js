// utils/pathResolver.js
/**
 * Path Resolver
 *
 * Handles environment-specific path resolution
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

class PathResolver {
  constructor() {
    // Default paths
    this.defaultPaths = {
      base: "/opt/cloudlunacy_front",
      config: "/opt/cloudlunacy_front/config",
      agents: "/opt/cloudlunacy_front/config/agents",
      dynamic: "/opt/cloudlunacy_front/config/dynamic.yml",
      docker: "/opt/cloudlunacy_front/docker-compose.yml",
    };

    // Container paths
    this.containerPaths = {
      base: "/app",
      config: "/app/config",
      agents: "/app/config/agents",
      dynamic: "/app/config/dynamic.yml",
      docker: "/app/docker-compose.yml",
    };

    // Fallback paths
    this.fallbackPaths = {
      base: "/etc/traefik",
      config: "/etc/traefik",
      agents: "/etc/traefik/agents",
      dynamic: "/etc/traefik/dynamic.yml",
      docker: null,
    };

    // Environment detection
    this.isDocker = false;
    this.isInitialized = false;
  }

  /**
   * Initialize the path resolver
   */
  async initialize() {
    if (this.isInitialized) {
      return this;
    }

    // Detect if running in Docker
    this.isDocker = this.checkIfRunningInDocker();

    // Find appropriate docker-compose path
    if (!this.isDocker) {
      await this.findDockerComposePath();
    }

    this.isInitialized = true;
    return this;
  }

  /**
   * Check if running in Docker container
   */
  checkIfRunningInDocker() {
    try {
      return (
        fs.existsSync("/.dockerenv") ||
        (fs.existsSync("/proc/1/cgroup") &&
          fs.readFileSync("/proc/1/cgroup", "utf8").includes("docker"))
      );
    } catch (err) {
      // If error, assume not in Docker
      return false;
    }
  }

  /**
   * Find docker-compose.yml path
   */
  async findDockerComposePath() {
    const possiblePaths = [
      this.defaultPaths.docker,
      path.join(process.cwd(), "docker-compose.yml"),
      path.join(path.dirname(process.cwd()), "docker-compose.yml"),
      "/opt/cloudlunacy_front/docker-compose.yml",
      "/docker-compose.yml",
    ];

    for (const filePath of possiblePaths) {
      try {
        if (fs.existsSync(filePath)) {
          this.defaultPaths.docker = filePath;
          return filePath;
        }
      } catch (err) {
        // Ignore errors and try next path
      }
    }

    return null;
  }

  /**
   * Resolve base directory path
   */
  resolveBasePath() {
    if (this.isDocker) {
      return this.containerPaths.base;
    }

    // Check environment variable
    if (process.env.BASE_DIR) {
      return process.env.BASE_DIR;
    }

    // Check if default path exists
    try {
      if (fs.existsSync(this.defaultPaths.base)) {
        return this.defaultPaths.base;
      }
    } catch (err) {
      // Ignore error
    }

    // Use current directory as fallback
    return process.cwd();
  }

  /**
   * Resolve config directory path
   */
  resolveConfigPath() {
    if (this.isDocker) {
      return this.containerPaths.config;
    }

    // Check environment variable
    if (process.env.CONFIG_DIR) {
      return process.env.CONFIG_DIR;
    }

    // Use base path + config
    const basePath = this.resolveBasePath();
    return path.join(basePath, "config");
  }

  /**
   * Resolve agents directory path
   */
  resolveAgentsPath() {
    if (this.isDocker) {
      return this.containerPaths.agents;
    }

    // Check environment variable
    if (process.env.AGENTS_CONFIG_DIR) {
      return process.env.AGENTS_CONFIG_DIR;
    }

    // Use config path + agents
    const configPath = this.resolveConfigPath();
    return path.join(configPath, "agents");
  }

  /**
   * Resolve dynamic config path
   */
  resolveDynamicConfigPath() {
    if (this.isDocker) {
      return this.containerPaths.dynamic;
    }

    // Check environment variable
    if (process.env.DYNAMIC_CONFIG_PATH) {
      return process.env.DYNAMIC_CONFIG_PATH;
    }

    // Use config path + dynamic.yml
    const configPath = this.resolveConfigPath();
    return path.join(configPath, "dynamic.yml");
  }

  /**
   * Resolve docker-compose path
   */
  resolveDockerComposePath() {
    if (this.isDocker) {
      return this.containerPaths.docker;
    }

    // Check environment variable
    if (process.env.DOCKER_COMPOSE_PATH) {
      return process.env.DOCKER_COMPOSE_PATH;
    }

    // Return found path
    return this.defaultPaths.docker;
  }

  /**
   * Resolve fallback paths if primary paths fail
   */
  resolveFallbackPaths() {
    return this.fallbackPaths;
  }

  /**
   * Resolve path for a relative path
   */
  resolveRelativePath(relativePath) {
    const basePath = this.resolveBasePath();
    return path.isAbsolute(relativePath)
      ? relativePath
      : path.join(basePath, relativePath);
  }

  /**
   * Check if a path exists and is accessible
   */
  async checkPathAccess(filePath) {
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * Check if a path is writable
   */
  async checkPathWritable(filePath) {
    try {
      // Try to create the directory if it doesn't exist
      const dirPath = path.dirname(filePath);
      await fs.promises.mkdir(dirPath, { recursive: true });

      // Try to write a test file
      const testPath = path.join(dirPath, ".write-test");
      await fs.promises.writeFile(testPath, "test");
      await fs.promises.unlink(testPath);

      return true;
    } catch (err) {
      return false;
    }
  }
}

module.exports = new PathResolver();
