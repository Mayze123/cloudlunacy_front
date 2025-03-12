#!/usr/bin/env node
/**
 * Startup Configuration Validator
 *
 * This script runs at system startup to validate and fix MongoDB configuration.
 * It ensures:
 * 1. Traefik configuration is valid
 * 2. MongoDB port is properly exposed
 * 3. Agent configurations are correct
 * 4. Connectivity is working
 *
 * Usage: node startup-validator.js
 */

require("dotenv").config();
const configValidator = require("../utils/configValidator");
const connectivityTester = require("../utils/connectivityTester");
const logger = require("../utils/logger").getLogger("startupValidator");

// Startup validation timeout (3 minutes)
const STARTUP_TIMEOUT = 3 * 60 * 1000;

async function runStartupValidation() {
  logger.info("Starting MongoDB configuration validation on system startup");

  try {
    // Set a timeout for the entire process
    const timeoutId = setTimeout(() => {
      logger.error("Startup validation timed out after 3 minutes");
      process.exit(1);
    }, STARTUP_TIMEOUT);

    // Step 1: Validate and fix configuration
    logger.info("Step 1: Validating configuration");
    const configResult = await configValidator.validateAndFix();

    if (!configResult.valid) {
      logger.error("Configuration validation failed:", configResult);
    } else if (configResult.traefikRestarted) {
      logger.info("Configuration was fixed and Traefik was restarted");

      // Wait for Traefik to fully restart
      logger.info("Waiting for Traefik to become available...");
      await new Promise((resolve) => setTimeout(resolve, 10000));
    } else {
      logger.info("Configuration is valid, no fixes needed");
    }

    // Step 2: Test connectivity
    logger.info("Step 2: Testing connectivity");
    const connectivityResult = await connectivityTester.runFullTest();

    // Log results
    if (connectivityResult.traefik.success) {
      logger.info("Traefik MongoDB listener is active");
    } else {
      logger.error(
        "Traefik MongoDB listener is not active - MongoDB connections will fail!"
      );
    }

    if (connectivityResult.agents.success) {
      logger.info("All agent MongoDB connections are working properly");
    } else {
      logger.warn(
        "Some agent MongoDB connections have issues:",
        connectivityResult.agents.agents
          .filter((a) => !a.connectivity.success)
          .map((a) => a.agentId)
      );
    }

    // Clear timeout
    clearTimeout(timeoutId);

    // Return final results
    return {
      configuration: configResult,
      connectivity: connectivityResult,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    logger.error(`Startup validation failed with error: ${err.message}`, {
      error: err.message,
      stack: err.stack,
    });
    return {
      success: false,
      error: err.message,
      timestamp: new Date().toISOString(),
    };
  }
}

// Run the validation if this script is executed directly
if (require.main === module) {
  runStartupValidation()
    .then((result) => {
      // Log final status
      if (result.error) {
        logger.error("Startup validation completed with errors");
        process.exit(1);
      } else {
        logger.info("Startup validation completed successfully");
        process.exit(0);
      }
    })
    .catch((err) => {
      logger.error(`Unhandled error in startup validation: ${err.message}`);
      process.exit(1);
    });
}
