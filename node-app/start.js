#!/usr/bin/env node
/**
 * CloudLunacy Front Server Entry Point
 *
 * This is an improved version of the start.js script with better error handling
 * and diagnostics to identify startup issues.
 */

require("dotenv").config();
const logger = require("./utils/logger").getLogger("startup");
const pathManager = require("./utils/pathManager");
const server = require("./server");

async function startup() {
  try {
    logger.info("Starting application...");
    
    // Initialize path manager first
    logger.info("Initializing path manager");
    await pathManager.initialize();
    
    // Log all paths for debugging
    logger.debug("Path configuration:", pathManager.getAllPaths());
    
    // Start the server
    logger.info("Starting server");
    await server.startServer();
    
    logger.info("Application started successfully");
  } catch (err) {
    logger.error(`Failed to start application: ${err.message}`, {
      error: err.message,
      stack: err.stack
    });
    process.exit(1);
  }
}

// Start the application
startup();
