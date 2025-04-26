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
const connectivityTester = require("./utils/connectivityTester");
const traefikMetricsManager = require("./utils/traefikMetricsManager");
const { promisify } = require("util");
const exec = promisify(require("child_process").exec);

async function startup() {
  try {
    logger.info("Starting application...");

    // Initialize path manager first
    logger.info("Initializing path manager");
    await pathManager.initialize();

    // Log all paths for debugging
    logger.debug("Path configuration:", pathManager.getAllPaths());

    // Initialize the health monitoring systems
    logger.info("Initializing health monitoring");
    await initializeHealthMonitoring();

    // Check Traefik health and attempt recovery if needed
    logger.info("Performing initial health check of dependent services");
    await checkTraefikHealth();

    // Start the server
    logger.info("Starting server");
    await server.startServer();

    logger.info("Application started successfully");
  } catch (err) {
    logger.error(`Failed to start application: ${err.message}`, {
      error: err.message,
      stack: err.stack,
    });
    process.exit(1);
  }
}

/**
 * Initialize the health monitoring systems
 */
async function initializeHealthMonitoring() {
  try {
    // Initialize Traefik metrics manager to monitor Traefik health
    if (!traefikMetricsManager.isInitialized()) {
      await traefikMetricsManager.initialize();
      logger.info("Traefik metrics manager initialized");
    }
    
    // Set up periodic health checks for Traefik
    setInterval(checkTraefikHealth, 5 * 60 * 1000); // Check every 5 minutes
    
    return true;
  } catch (err) {
    logger.error(`Failed to initialize health monitoring: ${err.message}`);
    return false;
  }
}

/**
 * Check Traefik health and attempt recovery if needed
 */
async function checkTraefikHealth() {
  try {
    logger.info("Checking Traefik health");
    
    // Check if Traefik container is running with docker health status
    const { stdout: containerStatus } = await exec('docker ps -a --format "{{.Names}},{{.Status}}" --filter "name=traefik"');
    
    if (!containerStatus.includes("healthy")) {
      logger.warn("Traefik container is not healthy, attempting recovery");
      
      // First, check Consul health as it's a dependency for Traefik
      const { stdout: consulStatus } = await exec('docker ps -a --format "{{.Names}},{{.Status}}" --filter "name=consul"');
      
      if (!consulStatus.includes("healthy")) {
        logger.warn("Consul container is not healthy, restarting");
        await exec("docker restart consul");
        
        // Wait for Consul to be healthy
        logger.info("Waiting for Consul to become healthy");
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
      
      // Check connectivity between services
      const testResult = await connectivityTester.testConnection("consul", 8500);
      logger.info(`Consul connectivity test result: ${testResult ? "SUCCESS" : "FAILED"}`);
      
      // If Traefik is unhealthy, restart it
      logger.info("Restarting Traefik container");
      await exec("docker restart traefik");
      
      // Wait for Traefik to restart
      logger.info("Waiting for Traefik to become healthy");
      await new Promise(resolve => setTimeout(resolve, 15000));
      
      // Verify that Traefik recovered
      const { stdout: newStatus } = await exec('docker ps -a --format "{{.Names}},{{.Status}}" --filter "name=traefik"');
      logger.info(`Traefik status after recovery: ${newStatus}`);
      
      return newStatus.includes("healthy");
    }
    
    logger.info("Traefik is healthy");
    return true;
  } catch (err) {
    logger.error(`Failed to check Traefik health: ${err.message}`);
    return false;
  }
}

// Start the application
startup();
