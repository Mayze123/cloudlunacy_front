// api/controllers/configController.js
/**
 * Config Controller
 *
 * Handles configuration management and retrieval.
 */

const configManager = require("../../services/configManager");
const mongodbManager = require("../../services/mongodbManager");
const logger = require("../../utils/logger").getLogger("configController");

/**
 * Get global configuration
 *
 * GET /api/config
 */
exports.getConfig = async (req, res, next) => {
  try {
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
  } catch (err) {
    logger.error(`Failed to get configuration: ${err.message}`, {
      error: err.message,
      stack: err.stack,
    });

    next(err);
  }
};

/**
 * Get Traefik configuration
 *
 * GET /api/frontdoor/config
 */
exports.getTraefikConfig = async (req, res, next) => {
  try {
    logger.info("Getting Traefik configuration");

    // Make sure config manager is initialized
    await configManager.initialize();

    // Get main configuration
    const config = configManager.configs.main;

    res.status(200).json({
      success: true,
      config,
    });
  } catch (err) {
    logger.error(`Failed to get Traefik configuration: ${err.message}`, {
      error: err.message,
      stack: err.stack,
    });

    next(err);
  }
};

/**
 * Repair configurations
 *
 * POST /api/config/repair
 */
exports.repairConfig = async (req, res, next) => {
  try {
    logger.info("Repairing configurations");

    // Repair configurations
    await configManager.repairAllConfigurations();

    // Ensure MongoDB port is properly configured
    const mongodbPortFixed = await mongodbManager.ensureMongoDBPort();

    // Ensure MongoDB entrypoint is properly configured
    const mongodbEntrypointFixed =
      await mongodbManager.ensureMongoDBEntrypoint();

    // Restart Traefik to apply changes
    await mongodbManager.restartTraefik();

    res.status(200).json({
      success: true,
      message: "Configurations repaired successfully",
      details: {
        configRepaired: true,
        mongodbPortFixed,
        mongodbEntrypointFixed,
      },
    });
  } catch (err) {
    logger.error(`Failed to repair configurations: ${err.message}`, {
      error: err.message,
      stack: err.stack,
    });

    next(err);
  }
};

/**
 * Get agent configuration
 *
 * GET /api/config/:agentId
 */
exports.getAgentConfig = async (req, res, next) => {
  try {
    const { agentId } = req.params;

    logger.info(`Getting configuration for agent ${agentId}`);

    // Make sure config manager is initialized
    await configManager.initialize();

    // Get agent configuration
    const config = await configManager.getAgentConfig(agentId);

    res.status(200).json({
      success: true,
      agentId,
      config,
    });
  } catch (err) {
    logger.error(`Failed to get agent configuration: ${err.message}`, {
      error: err.message,
      stack: err.stack,
      agentId: req.params.agentId,
    });

    next(err);
  }
};
