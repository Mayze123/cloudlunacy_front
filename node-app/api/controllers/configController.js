// api/controllers/configController.js
/**
 * Config Controller
 *
 * Handles configuration management and retrieval.
 */

// Replace old imports with core services
const coreServices = require("../../services/core");
const logger = require("../../utils/logger").getLogger("configController");
const { asyncHandler } = require("../../utils/errorHandler");

/**
 * Get global configuration
 *
 * GET /api/config
 */
exports.getConfig = asyncHandler(async (req, res) => {
  logger.info("Getting global configuration");

  // Get configuration domains
  const domains = {
    app: process.env.APP_DOMAIN || "apps.cloudlunacy.uk",
    mongo: process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk",
  };

  // Get port configuration
  const ports = {
    node: process.env.NODE_PORT || 3005,
    traefik: 8081,
    mongo: 27017,
  };

  res.status(200).json({
    success: true,
    domains,
    ports,
    env: process.env.NODE_ENV || "development",
  });
});

/**
 * Get Traefik configuration
 *
 * GET /api/frontdoor/config
 */
exports.getTraefikConfig = asyncHandler(async (req, res) => {
  logger.info("Getting Traefik configuration");

  // Make sure config manager is initialized
  await coreServices.config.initialize();

  // Get main configuration
  const config = coreServices.config.configs.main;

  res.status(200).json({
    success: true,
    config,
  });
});

/**
 * Repair configurations
 *
 * POST /api/config/repair
 */
exports.repairConfig = asyncHandler(async (req, res) => {
  logger.info("Repairing configurations");

  // Repair configurations
  await coreServices.config.repair();

  // Ensure MongoDB port is properly configured
  const mongodbPortFixed = await coreServices.mongodb.ensureMongoDBPort();

  // Ensure MongoDB entrypoint is properly configured
  const mongodbEntrypointFixed =
    await coreServices.mongodb.ensureMongoDBEntrypoint();

  // Restart Traefik to apply changes
  await coreServices.mongodb.restartTraefik();

  res.status(200).json({
    success: true,
    message: "Configurations repaired successfully",
    details: {
      configRepaired: true,
      mongodbPortFixed,
      mongodbEntrypointFixed,
    },
  });
});

/**
 * Get agent configuration
 *
 * GET /api/config/:agentId
 */
exports.getAgentConfig = asyncHandler(async (req, res) => {
  const { agentId } = req.params;

  logger.info(`Getting configuration for agent ${agentId}`);

  // Make sure config manager is initialized
  await coreServices.config.initialize();

  // Get agent configuration
  const config = await coreServices.config.getAgentConfig(agentId);

  res.status(200).json({
    success: true,
    agentId,
    config,
  });
});
