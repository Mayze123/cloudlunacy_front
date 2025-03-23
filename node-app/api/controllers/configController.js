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
 * Repair system configuration
 *
 * POST /api/config/repair
 */
exports.repairConfig = asyncHandler(async (req, res) => {
  logger.info("Repairing system configuration");

  // Repair routing configuration
  await coreServices.configService.repair();

  res.status(200).json({
    success: true,
    message: "System configuration repaired",
  });
});

/**
 * Get agent-specific configuration
 *
 * GET /api/config/:agentId
 */
exports.getAgentConfig = asyncHandler(async (req, res) => {
  const { agentId } = req.params;

  logger.info(`Getting configuration for agent ${agentId}`);

  // Make sure config service is initialized
  await coreServices.configService.initialize();

  // Get agent-specific configuration
  const config = await coreServices.configService.getAgentConfig(agentId);

  res.status(200).json({
    success: true,
    agentId,
    config,
  });
});
