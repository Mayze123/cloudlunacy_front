#!/usr/bin/env node
/**
 * CloudLunacy Front Server Entry Point
 *
 * This script initializes the environment and starts the front server
 * with proper path handling and initialization.
 */

// Standard modules
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
require("dotenv").config();

// Set up paths
const BASE_DIR = process.env.BASE_DIR || "/opt/cloudlunacy_front";
const NODE_APP_DIR =
  process.env.NODE_APP_DIR || path.join(BASE_DIR, "node-app");
const CONFIG_DIR = process.env.CONFIG_DIR || path.join(BASE_DIR, "config");
const SCRIPTS_DIR =
  process.env.SCRIPTS_DIR || path.join(NODE_APP_DIR, "scripts");

// Determine if running in Docker
const isInDocker = () => {
  try {
    return (
      fs.existsSync("/.dockerenv") ||
      (fs.existsSync("/proc/1/cgroup") &&
        fs.readFileSync("/proc/1/cgroup", "utf8").includes("docker"))
    );
  } catch (err) {
    return false;
  }
};

// Create necessary directories
function ensureDirectoriesExist() {
  const dirsToCreate = [
    "/app/scripts", // Scripts in Docker container
    "/app/config", // Config in Docker container
    "/app/config/agents", // Agent configs
    CONFIG_DIR, // Host config dir
    path.join(CONFIG_DIR, "agents"), // Host agent configs
  ];

  for (const dir of dirsToCreate) {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`Created directory: ${dir}`);
      }
    } catch (err) {
      console.warn(
        `Warning: Could not create directory ${dir}: ${err.message}`
      );
    }
  }
}

// Create symlinks between different path locations
function createPathSymlinks() {
  // Map scripts directory
  if (isInDocker()) {
    if (fs.existsSync(SCRIPTS_DIR) && !fs.existsSync("/app/scripts")) {
      try {
        // Create symlink for entire directory
        fs.symlinkSync(SCRIPTS_DIR, "/app/scripts", "dir");
        console.log("Created symlink from /app/scripts to ", SCRIPTS_DIR);
      } catch (err) {
        console.warn(`Could not create scripts symlink: ${err.message}`);

        // Try copying files instead
        try {
          fs.mkdirSync("/app/scripts", { recursive: true });
          const files = fs.readdirSync(SCRIPTS_DIR);
          for (const file of files) {
            fs.copyFileSync(
              path.join(SCRIPTS_DIR, file),
              path.join("/app/scripts", file)
            );
          }
          console.log("Copied script files instead of symlinking");
        } catch (copyErr) {
          console.error(`Failed to copy script files: ${copyErr.message}`);
        }
      }
    }
  }
}

// Run startup validation
async function runStartupValidation() {
  try {
    // Try multiple possible paths for startup validator
    const possiblePaths = [
      "/app/scripts/startup-validator.js",
      path.join(SCRIPTS_DIR, "startup-validator.js"),
      path.join(NODE_APP_DIR, "scripts/startup-validator.js"),
      "./scripts/startup-validator.js",
    ];

    let validatorPath = null;
    for (const testPath of possiblePaths) {
      try {
        if (fs.existsSync(testPath)) {
          validatorPath = testPath;
          break;
        }
      } catch (err) {
        // Ignore errors, just continue checking
      }
    }

    if (validatorPath) {
      console.log(`Running startup validation from ${validatorPath}`);
      try {
        // Try to run with Node.js
        const validator = require(validatorPath);
        await validator.runStartupValidation();
      } catch (requireErr) {
        console.warn(`Could not require validator: ${requireErr.message}`);
        // Fall back to running as a separate process
        execSync(`node ${validatorPath}`, { stdio: "inherit" });
      }
    } else {
      console.warn("Could not find startup-validator.js script");
    }
  } catch (err) {
    console.error(`Error running startup validation: ${err.message}`);
    // Continue anyway - don't fail the entire server startup if validation fails
  }
}

// Start the front server
function startFrontServer() {
  try {
    // Determine the correct path to the front server
    const serverPaths = [
      "/app/frontdoorService.js",
      path.join(NODE_APP_DIR, "frontdoorService.js"),
      "./frontdoorService.js",
    ];

    let serverPath = null;
    for (const testPath of serverPaths) {
      try {
        if (fs.existsSync(testPath)) {
          serverPath = testPath;
          break;
        }
      } catch (err) {
        // Ignore errors, just continue checking
      }
    }

    if (!serverPath) {
      throw new Error("Could not find frontdoorService.js");
    }

    console.log(`Starting front server from ${serverPath}`);
    const server = require(serverPath);
  } catch (err) {
    console.error(`Failed to start front server: ${err.message}`);
    process.exit(1);
  }
}

// Main process
async function main() {
  try {
    console.log("Initializing CloudLunacy Front Server...");

    // Step 1: Ensure directories exist
    ensureDirectoriesExist();

    // Step 2: Create path symlinks
    createPathSymlinks();

    // Step 3: Run startup validation
    await runStartupValidation();

    // Step 4: Start the front server
    startFrontServer();

    console.log("CloudLunacy Front Server initialization completed");
  } catch (err) {
    console.error(`Front server initialization failed: ${err.message}`);
    process.exit(1);
  }
}

// Run the main function
main().catch((err) => {
  console.error(`Unhandled error in main: ${err.message}`);
  process.exit(1);
});
