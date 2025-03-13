#!/usr/bin/env node
/**
 * CloudLunacy Front Server Entry Point
 *
 * This is an improved version of the start.js script with better error handling
 * and diagnostics to identify startup issues.
 */

const path = require("path");
const fs = require("fs");
const { execSync, spawn } = require("child_process");

// Set up error logging to a file
const logDir = "/app/logs";
if (!fs.existsSync(logDir)) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (err) {
    // Fallback to /tmp if can't create in /app
    logDir = "/tmp";
  }
}

const logFile = path.join(logDir, "startup-errors.log");

// Log helper with timestamp and file logging
function log(message, isError = false) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [start.js] ${message}`;

  console.log(logMessage);

  // Also log to file if it's an error
  if (isError) {
    try {
      fs.appendFileSync(logFile, logMessage + "\n");
    } catch (err) {
      console.error(`Failed to write to log file: ${err.message}`);
    }
  }
}

// Error logger
function logError(message, error) {
  log(`ERROR: ${message}: ${error.message}`, true);
  if (error.stack) {
    log(`Stack trace: ${error.stack}`, true);
  }
}

// Find a file from multiple possible locations
function findFile(fileName, possibleDirs) {
  for (const dir of possibleDirs) {
    const filePath = path.join(dir, fileName);
    try {
      if (fs.existsSync(filePath)) {
        return filePath;
      }
    } catch (err) {
      // Ignore errors, just continue checking
    }
  }
  return null;
}

// Check what environment we're running in
function getEnvironmentInfo() {
  const info = {
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    cwd: process.cwd(),
    env: process.env.NODE_ENV || "not set",
    user: process.getuid ? process.getuid() : "N/A",
    inDocker: false,
  };

  try {
    info.inDocker =
      fs.existsSync("/.dockerenv") ||
      (fs.existsSync("/proc/1/cgroup") &&
        fs.readFileSync("/proc/1/cgroup", "utf8").includes("docker"));
  } catch (err) {
    // Ignore error checking for Docker
  }

  return info;
}

// Verify directory permissions
function checkDirectoryPermissions(dir) {
  try {
    const testFile = path.join(dir, ".permission_check");
    fs.writeFileSync(testFile, "test");
    fs.unlinkSync(testFile);
    return true;
  } catch (err) {
    logError(`No write permission to directory ${dir}`, err);
    return false;
  }
}

// List the files in a directory
function listDirectory(dir) {
  try {
    if (fs.existsSync(dir)) {
      return fs.readdirSync(dir);
    }
  } catch (err) {
    logError(`Failed to list directory ${dir}`, err);
  }
  return [];
}

// Main function
async function main() {
  try {
    log("Starting the CloudLunacy Front Server...");

    // Log environment information
    const envInfo = getEnvironmentInfo();
    log(`Environment: ${JSON.stringify(envInfo, null, 2)}`);

    // Ensure necessary directories exist
    const dirsToCreate = [
      "/app/scripts",
      "/app/config",
      "/app/config/agents",
      "/app/logs",
    ];

    for (const dir of dirsToCreate) {
      if (!fs.existsSync(dir)) {
        log(`Creating directory: ${dir}`);
        try {
          fs.mkdirSync(dir, { recursive: true });
        } catch (err) {
          logError(`Failed to create directory ${dir}`, err);
        }
      }

      // Check directory permissions
      checkDirectoryPermissions(dir);
    }

    // List files in key directories
    log("Files in current directory:");
    log(JSON.stringify(listDirectory(process.cwd())));

    log("Files in /app:");
    log(JSON.stringify(listDirectory("/app")));

    log("Files in /app/scripts:");
    log(JSON.stringify(listDirectory("/app/scripts")));

    // Possible locations for scripts and main service
    const possibleDirs = [
      "/app",
      "/app/scripts",
      "/node-app",
      "/node-app/scripts",
      "/opt/cloudlunacy_front/node-app",
      "/opt/cloudlunacy_front/node-app/scripts",
      ".",
      "./scripts",
      process.cwd(),
      path.join(process.cwd(), "scripts"),
    ];

    // Find the main service file - UPDATED to look for server.js
    const servicePath = findFile("server.js", possibleDirs);
    if (!servicePath) {
      throw new Error("Could not find server.js in any of the usual locations");
    }

    log(`Found server.js at ${servicePath}`);

    // Check if file is readable
    try {
      const stats = fs.statSync(servicePath);
      log(
        `Service file size: ${
          stats.size
        } bytes, permissions: ${stats.mode.toString(8)}`
      );
    } catch (err) {
      logError(`Cannot access service file ${servicePath}`, err);
    }

    // Find and run startup validator
    const validatorPath = findFile("startup-validator.js", possibleDirs);
    if (validatorPath) {
      log(`Running startup validator from ${validatorPath}`);
      try {
        const output = execSync(`node ${validatorPath}`, { encoding: "utf8" });
        log(`Startup validation output: ${output}`);
      } catch (err) {
        logError("Startup validator failed", err);
        log(`Validator stderr: ${err.stderr || "none"}`, true);
        // Continue anyway - don't fail if validation has issues
      }
    } else {
      log("Warning: Could not find startup-validator.js", true);
    }

    // Start the main service
    log(`Starting main service from ${servicePath}`);

    // Use spawn to run in the same process
    const serviceProcess = spawn("node", [servicePath], {
      stdio: "inherit",
      env: {
        ...process.env,
        DEBUG: "*", // Enable debug output
        NODE_DEBUG: "net,http,stream", // More debugging
      },
    });

    // Handle process events
    serviceProcess.on("close", (code) => {
      if (code !== 0) {
        log(`Main service exited with code ${code}`, true);
      } else {
        log(`Main service exited normally with code ${code}`);
      }
      process.exit(code);
    });

    serviceProcess.on("error", (err) => {
      logError("Failed to start main service process", err);
      process.exit(1);
    });

    // Handle signals to pass through to child process
    process.on("SIGTERM", () => {
      log("Received SIGTERM, shutting down...");
      serviceProcess.kill("SIGTERM");
    });

    process.on("SIGINT", () => {
      log("Received SIGINT, shutting down...");
      serviceProcess.kill("SIGINT");
    });

    log("Startup sequence completed, service should now be running");
  } catch (err) {
    logError("Fatal error in start.js", err);
    process.exit(1);
  }
}

// Handle uncaught exceptions
process.on("uncaughtException", (err) => {
  logError("Uncaught exception in start.js", err);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason) => {
  logError("Unhandled promise rejection", new Error(String(reason)));
  process.exit(1);
});

// Run the main function
main().catch((err) => {
  logError("Unhandled error in main()", err);
  process.exit(1);
});
