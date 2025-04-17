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

  // Register the MongoDB instance
  const result = await coreServices.mongodbService.registerAgent(
    agentId,
    targetIp,
    {
      useTls,
      targetPort,
    }
  );

  if (!result.success) {
    throw new AppError(`Failed to register MongoDB: ${result.error}`, 500);
  }

  // Generate the connection string
  const domain = `${agentId}.${
    process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk"
  }`;
  const connectionString = `mongodb://username:password@${domain}:27017/admin?${
    useTls ? "tls=true&tlsAllowInvalidCertificates=true" : ""
  }`;

  // Update HAProxy configuration using the enhanced service instead of the legacy manager
  try {
    // Use enhancedHAProxyService if available, otherwise fall back to standard haproxyService
    const haproxyService =
      coreServices.enhancedHAProxyService || coreServices.haproxyService;
    await haproxyService.addMongoDBRoute(agentId, targetIp, targetPort, {
      useTls,
    });

    logger.info(`Successfully updated HAProxy for MongoDB agent ${agentId}`);
  } catch (haproxyErr) {
    logger.error(`Failed to update HAProxy for MongoDB: ${haproxyErr.message}`);
    // Continue anyway - the MongoDB registration was successful
  }

  // Return success response
  res.status(200).json({
    success: true,
    message: "MongoDB registered successfully",
    domain,
    connectionString,
    targetIp,
    targetPort,
    tlsEnabled: useTls,
  });
});

/**
 * List all MongoDB subdomains
 *
 * GET /api/mongodb
 */
exports.listSubdomains = asyncHandler(async (req, res) => {
  logger.info("Listing all MongoDB subdomains");

  // Get all routes using the enhanced HAProxy service
  try {
    // Use enhancedHAProxyService if available, otherwise fall back to haproxyService
    const haproxyService =
      coreServices.enhancedHAProxyService || coreServices.haproxyService;

    // Ensure service is initialized
    if (!haproxyService.initialized) {
      await haproxyService.initialize();
    }

    // Get all routes
    const routesResponse = await haproxyService.getAllRoutes();

    // Filter for MongoDB routes
    const mongoRoutes = routesResponse.routes
      .filter((route) => route.type === "mongodb")
      .map((route) => ({
        name: route.name || `mongodb-agent-${route.agentId}`,
        agentId: route.agentId,
        targetAddress: `${route.targetHost}:${route.targetPort}`,
        lastUpdated: route.lastUpdated,
      }));

    res.status(200).json({
      success: true,
      count: mongoRoutes.length,
      subdomains: mongoRoutes,
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

  // Remove the MongoDB subdomain
  const result = await coreServices.mongodbService.deregisterAgent(agentId);

  if (!result.success) {
    throw new AppError(
      `Failed to remove MongoDB subdomain for agent ${agentId}: ${result.error}`,
      404
    );
  }

  res.status(200).json(result);
});

/**
 * Test MongoDB connectivity
 *
 * GET /api/mongodb/:agentId/test
 */
exports.testConnection = asyncHandler(async (req, res) => {
  const { agentId } = req.params;

  logger.info(`Testing MongoDB connectivity for agent ${agentId}`);

  // Test MongoDB connectivity
  const result = await coreServices.mongodbService.testConnection(agentId);

  res.status(200).json({
    success: true,
    result,
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
      connectionString: connectionInfo.connectionString.replace(
        /:[^:]*@/,
        ":***@"
      ), // Hide password
      host: connectionInfo.host,
      port: connectionInfo.port,
      useTls: connectionInfo.useTls,
    },
  });
});

/**
 * Generate MongoDB credentials for a database
 *
 * POST /api/mongodb/:agentId/credentials
 * {
 *   "dbName": "myDatabase",
 *   "username": "optional-username" // If not provided, will be generated
 * }
 */
exports.generateCredentials = asyncHandler(async (req, res) => {
  const { agentId } = req.params;
  const { dbName, username } = req.body;

  if (!dbName) {
    throw new AppError("Missing required parameter: dbName is required", 400);
  }

  logger.info(
    `Generating MongoDB credentials for database ${dbName} on agent ${agentId}`
  );

  // Generate credentials
  const credentials = await coreServices.mongodbService.generateCredentials(
    agentId,
    dbName,
    username
  );

  if (!credentials.success) {
    throw new AppError(
      `Failed to generate credentials: ${credentials.error}`,
      500
    );
  }

  res.status(201).json({
    success: true,
    credentials: {
      username: credentials.username,
      password: credentials.password,
      connectionString: credentials.connectionString.replace(
        /:[^:]*@/,
        ":***@"
      ), // Hide password in logs
      dbName,
    },
  });
});
