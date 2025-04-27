// api/controllers/mongodbController.js
/**
 * MongoDB Controller
 *
 * Handles MongoDB subdomain registration and management.
 */

const coreServices = require("../../services/core");
const logger = require("../../utils/logger").getLogger("mongodbController");
const { AppError, asyncHandler } = require("../../utils/errorHandler");

/**
 * Register MongoDB
 *
 * POST /api/mongodb/register
 */
exports.registerMongoDB = asyncHandler(async (req, res) => {
  const { agentId, targetIp, targetPort = 27017, useTls = true } = req.body;

  if (!agentId || !targetIp) {
    throw new AppError(
      "Missing required parameters: agentId and targetIp are required",
      400,
      { received: { agentId, targetIp } }
    );
  }

  logger.info(
    `Registering MongoDB for agent ${agentId} at ${targetIp}:${targetPort}`,
    {
      useTls,
      requestIP: req.ip,
    }
  );

  // Register with MongoDB service (using Traefik only)
  try {
    const result = await coreServices.mongodbService.registerAgent(
      agentId,
      targetIp,
      {
        useTls,
        targetPort,
      }
    );

    if (!result.success) {
      logger.error(`MongoDB registration failed: ${result.error}`);
      throw new AppError(`Failed to register MongoDB: ${result.error}`, 500);
    }

    // At this point we have a successful registration
    const domain = `${agentId}.${
      process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk"
    }`;
    const connectionString = `mongodb://username:password@${domain}:27017/admin?${
      useTls ? "tls=true&tlsAllowInvalidCertificates=true" : ""
    }`;

    // Return success response
    res.status(200).json({
      success: true,
      message: `MongoDB registered successfully`,
      domain,
      connectionString,
      targetIp: result.targetIp, // Use normalized IP from result
      targetPort,
      tlsEnabled: useTls,
    });
  } catch (error) {
    logger.error(`MongoDB registration error: ${error.message}`);
    throw new AppError(`Failed to register MongoDB: ${error.message}`, 500);
  }
});

/**
 * List all MongoDB subdomains
 *
 * GET /api/mongodb
 */
exports.listSubdomains = asyncHandler(async (req, res) => {
  logger.info("Listing all MongoDB subdomains");

  try {
    // Get all routes using the MongoDB service
    if (!coreServices.mongodbService.initialized) {
      await coreServices.mongodbService.initialize();
    }

    // Get all connection info from the cache
    const mongodbConnections = [];
    coreServices.mongodbService.connectionCache.forEach((info) => {
      mongodbConnections.push({
        name: `mongodb-agent-${info.agentId}`,
        agentId: info.agentId,
        targetAddress: `${info.targetIp}:${info.targetPort}`,
        lastUpdated: info.lastUpdated || info.created,
      });
    });

    res.status(200).json({
      success: true,
      count: mongodbConnections.length,
      subdomains: mongodbConnections,
    });
  } catch (err) {
    logger.error(`Failed to list MongoDB subdomains: ${err.message}`);
    throw new AppError(
      `Failed to list MongoDB subdomains: ${err.message}`,
      500
    );
  }
});

/**
 * Remove a MongoDB subdomain
 *
 * DELETE /api/mongodb/:agentId
 */
exports.removeSubdomain = asyncHandler(async (req, res) => {
  const { agentId } = req.params;

  logger.info(`Removing MongoDB subdomain for agent ${agentId}`);

  // First get connection info to have details for the logs
  let connectionInfo = null;
  try {
    connectionInfo = await coreServices.mongodbService.getConnectionInfo(
      agentId
    );
  } catch (infoErr) {
    // Continue even if we can't get info - might still be able to deregister
    logger.warn(
      `Could not get connection info before removal: ${infoErr.message}`
    );
  }

  // Try to remove MongoDB registration
  const result = await coreServices.mongodbService.deregisterAgent(agentId);

  if (!result.success) {
    logger.error(
      `Failed to remove MongoDB for agent ${agentId}: ${
        result.error || "Unknown error"
      }`
    );
    throw new AppError(
      `Failed to remove MongoDB subdomain for agent ${agentId}: ${result.error}`,
      404
    );
  }

  // Return success response
  res.status(200).json({
    success: true,
    message: `MongoDB subdomain for agent ${agentId} removed successfully`,
  });
});

/**
 * Get MongoDB connection information for an agent
 *
 * GET /api/mongodb/:agentId/connection-info
 */
exports.getConnectionInfo = asyncHandler(async (req, res) => {
  const { agentId } = req.params;

  logger.info(`Getting MongoDB connection info for agent ${agentId}`);

  // Get MongoDB connection information
  const connectionInfo = await coreServices.mongodbService.getConnectionInfo(
    agentId
  );

  if (!connectionInfo) {
    throw new AppError(
      `No MongoDB connection information found for agent ${agentId}`,
      404
    );
  }

  res.status(200).json({
    success: true,
    connectionInfo: {
      domain: connectionInfo.domain,
      host: connectionInfo.targetIp,
      port: connectionInfo.targetPort,
      useTls: connectionInfo.useTls,
    },
  });
});
