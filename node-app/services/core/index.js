/**
 * Core Services Index
 *
 * Single entry point for all core services to ensure consistent initialization
 * and dependency management.
 */

const configService = require("./configService");
const agentService = require("./agentService");
const routingService = require("./routingService");
const mongodbService = require("./mongodbService");
const logger = require("../../utils/logger").getLogger("coreServices");

/**
 * Initialize all core services
 */
async function initialize() {
  try {
    logger.info("Initializing core services...");

    // Initialize config first as other services depend on it
    await configService.initialize();
    logger.info("Configuration service initialized");

    // Initialize MongoDB service
    await mongodbService.initialize();
    logger.info("MongoDB service initialized");

    // Initialize agent service
    await agentService.initialize();
    logger.info("Agent service initialized");

    // Initialize routing service
    await routingService.initialize();
    logger.info("Routing service initialized");

    logger.info("All core services initialized successfully");
    return true;
  } catch (err) {
    logger.error(`Failed to initialize core services: ${err.message}`, {
      error: err.message,
      stack: err.stack,
    });
    return false;
  }
}

/**
 * Repair all services (for recovery)
 */
async function repair() {
  try {
    logger.info("Repairing core services...");

    // Repair in dependency order
    await configService.repair();
    await mongodbService.repair();
    await agentService.repair();
    await routingService.repair();

    logger.info("Core services repaired successfully");
    return true;
  } catch (err) {
    logger.error(`Failed to repair core services: ${err.message}`, {
      error: err.message,
      stack: err.stack,
    });
    throw err;
  }
}

module.exports = {
  initialize,
  repair,
  config: configService,
  agent: agentService,
  routing: routingService,
  mongodb: mongodbService,
};
