// utils/pathHelper.js

const path = require("path");
const fs = require("fs");
const os = require("os");

class PathHelper {
  constructor() {
    // Define base paths
    this.baseDir = process.env.BASE_DIR || "/opt/cloudlunacy_front";
    this.appDir = process.env.APP_DIR || path.join(this.baseDir, "node-app");
    this.configDir =
      process.env.CONFIG_DIR || path.join(this.baseDir, "config");
    this.scriptsDir =
      process.env.SCRIPTS_DIR || path.join(this.appDir, "scripts");

    // Detect if we're running in Docker
    this.inDocker = this.isRunningInDocker();

    if (this.inDocker) {
      // Inside docker, scripts are expected to be at /app/scripts
      this.scriptsDir = "/app/scripts";
      // Config is at /app/config
      this.configDir = "/app/config";
    }

    // Create directories if they don't exist
    this.ensureDirectories();
  }

  /**
   * Check if we're running inside a Docker container
   */
  isRunningInDocker() {
    try {
      return (
        fs.existsSync("/.dockerenv") ||
        (fs.existsSync("/proc/1/cgroup") &&
          fs.readFileSync("/proc/1/cgroup", "utf8").includes("docker"))
      );
    } catch (err) {
      return false;
    }
  }

  /**
   * Ensure all required directories exist
   */
  ensureDirectories() {
    [
      this.baseDir,
      this.configDir,
      this.scriptsDir,
      path.join(this.configDir, "agents"),
    ].forEach((dir) => {
      try {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      } catch (err) {
        // Don't fail if we can't create the directory (might be a permissions issue)
        console.warn(
          `Warning: Could not create directory ${dir}: ${err.message}`
        );
      }
    });
  }

  /**
   * Resolve a path relative to the base directory
   */
  resolve(relativePath) {
    if (path.isAbsolute(relativePath)) {
      return relativePath;
    }
    return path.join(this.baseDir, relativePath);
  }

  /**
   * Resolve a path relative to the app directory
   */
  resolveApp(relativePath) {
    if (path.isAbsolute(relativePath)) {
      return relativePath;
    }
    return path.join(this.appDir, relativePath);
  }

  /**
   * Resolve a path relative to the config directory
   */
  resolveConfig(relativePath) {
    if (path.isAbsolute(relativePath)) {
      return relativePath;
    }
    return path.join(this.configDir, relativePath);
  }

  /**
   * Resolve a path relative to the scripts directory
   */
  resolveScript(relativePath) {
    if (path.isAbsolute(relativePath)) {
      return relativePath;
    }
    return path.join(this.scriptsDir, relativePath);
  }

  /**
   * Create a mapping between internal and external paths
   */
  createSymlinks() {
    // Only needed in Docker to map from expected paths to actual paths
    if (!this.inDocker) return;

    // Create a symlink from /app/scripts to the actual scripts directory if needed
    const dockerScriptsDir = "/app/scripts";
    if (!fs.existsSync(dockerScriptsDir)) {
      try {
        fs.mkdirSync(dockerScriptsDir, { recursive: true });

        // List all scripts and create symlinks
        const scriptFiles = fs.readdirSync(this.scriptsDir);
        scriptFiles.forEach((file) => {
          const sourcePath = path.join(this.scriptsDir, file);
          const targetPath = path.join(dockerScriptsDir, file);
          if (!fs.existsSync(targetPath)) {
            fs.symlinkSync(sourcePath, targetPath);
          }
        });
      } catch (err) {
        console.error(`Error creating script symlinks: ${err.message}`);
      }
    }
  }
}

module.exports = new PathHelper();
