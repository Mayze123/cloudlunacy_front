#!/usr/bin/env node
/**
 * CloudLunacy Front Server Entry Point
 *
 * This is a simplified version of the start.js script that focuses just on
 * running the startup validator and then the main frontdoorService.js
 */

const path = require("path");
const fs = require("fs");
const { execSync, spawn } = require("child_process");

// Log helper
function log(message) {
  console.log(`[start.js] ${message}`);
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

// Main function
async function main() {
  try {
    log("Starting the CloudLunacy Front Server...");

    // Ensure necessary directories exist
    const dirsToCreate = ["/app/scripts", "/app/config", "/app/config/agents"];
    for (const dir of dirsToCreate) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        log(`Created directory: ${dir}`);
      }
    }

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
    ];

    // Find and run startup validator
    const validatorPath = findFile("startup-validator.js", possibleDirs);
    if (validatorPath) {
      log(`Running startup validator from ${validatorPath}`);
      try {
        execSync(`node ${validatorPath}`, { stdio: "inherit" });
        log("Startup validation completed");
      } catch (err) {
        log(`Warning: Startup validator exited with error: ${err.message}`);
        // Continue anyway - don't fail if validation has issues
      }
    } else {
      log("Warning: Could not find startup-validator.js");
    }

    // Find and run main service
    const servicePath = findFile("frontdoorService.js", possibleDirs);
    if (servicePath) {
      log(`Starting main service from ${servicePath}`);
      // Use spawn to run in the same process
      const serviceProcess = spawn("node", [servicePath], { stdio: "inherit" });

      // Handle process events
      serviceProcess.on("close", (code) => {
        log(`Main service exited with code ${code}`);
        process.exit(code);
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
    } else {
      throw new Error("Could not find frontdoorService.js");
    }
  } catch (err) {
    console.error(`Error in start.js: ${err.message}`);
    process.exit(1);
  }
}

// Run the main function
main().catch((err) => {
  console.error(`Unhandled error in start.js: ${err.message}`);
  process.exit(1);
});
