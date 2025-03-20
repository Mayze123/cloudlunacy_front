/**
 * Core Services
 *
 * This module initializes and exports all core services.
 */

const pathManager = require("../../utils/pathManager");
const ConfigManager = require("./configManager");
const RoutingManager = require("./routingManager");
const MongoDBService = require("./mongodbService");
const AgentService = require("./agentService");
const CertificateService = require("./certificateService");
const logger = require("../../utils/logger").getLogger("coreServices");

// Initialize services
const configManager = new ConfigManager();
const routingManager = new RoutingManager(configManager);
const mongodbService = new MongoDBService(configManager, routingManager);
const certificateService = new CertificateService(configManager);
const agentService = new AgentService(configManager, mongodbService);

/**
 * Initialize all core services
 */
async function initialize() {
  logger.info("Initializing core services");

  try {
    // Initialize path manager first
    await pathManager.initialize();

    // Initialize in order of dependencies
    await configManager.initialize();
    await routingManager.initialize();
    await mongodbService.initialize();
    await agentService.initialize();
    await certificateService.initialize();

    logger.info("Core services initialized successfully");
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
 * Repair core services
 */
async function repair() {
  logger.info("Repairing core services");

  try {
    // Repair configuration
    await configManager.repair();

    // Ensure MongoDB port and entrypoint
    await mongodbService.ensureMongoDBPort();
    await mongodbService.ensureMongoDBEntrypoint();

    // Restart Traefik to apply changes
    await mongodbService.restartTraefik();

    logger.info("Core services repaired successfully");
    return true;
  } catch (err) {
    logger.error(`Failed to repair core services: ${err.message}`, {
      error: err.message,
      stack: err.stack,
    });
    return false;
  }
}

// Export all services
module.exports = {
  initialize,
  config: configManager,
  routing: routingManager,
  mongodb: mongodbService,
  agent: agentService,
  certificate: certificateService,
  repair,
};
