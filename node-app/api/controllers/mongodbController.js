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
 * Add a new MongoDB subdomain
 *
 * This endpoint supports both the old "frontdoor/add-subdomain" pattern
 * and the new direct MongoDB registration pattern.
 *
 * POST /api/frontdoor/add-subdomain
 * {
 *   "subdomain": "mongodb",
 *   "targetIp": "1.2.3.4",
 *   "agentId": "optional-agent-id"
 * }
 */
exports.addSubdomain = asyncHandler(async (req, res) => {
  const {
    subdomain,
    targetIp,
    agentId,
    targetPort = 27017,
    useTls = true,
  } = req.body;

  if (!subdomain || !targetIp) {
    throw new AppError(
      "Missing required parameters: subdomain and targetIp are required",
      400,
      { received: { subdomain, targetIp } }
    );
  }

  logger.info(
    `Adding MongoDB subdomain ${subdomain} with target IP ${targetIp}`
  );

  // Use the agent ID if provided, otherwise use the subdomain as the agent ID
  const effectiveAgentId = agentId || subdomain;

  // Register the MongoDB subdomain
  const result = await coreServices.mongodbService.registerAgent(
    effectiveAgentId,
    targetIp,
    {
      useTls,
      targetPort,
    }
  );

  if (!result.success) {
    throw new AppError(
      `Failed to register MongoDB agent: ${result.error}`,
      500
    );
  }

  res.status(201).json({
    success: true,
    subdomain: effectiveAgentId,
    domain: `${effectiveAgentId}.${coreServices.mongodbService.mongoDomain}`,
    targetIp,
    mongodbUrl: result.mongodbUrl,
    connectionString: result.connectionString,
    certificates: result.certificates,
  });
});

/**
 * Register MongoDB - Alternative endpoint that's more REST-like
 *
 * This implements the same functionality as addSubdomain but with
 * a more semantic REST endpoint name.
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

  // Update HAProxy configuration
  await coreServices.haproxyManager.updateMongoDBBackend(
    agentId,
    targetIp,
    targetPort
  );

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

  // Get all routes from HAProxy manager
  const routes = coreServices.haproxyManager
    .listRoutes()
    .filter(
      (route) => route.key.startsWith("tcp:") && route.key !== "tcp:mongodb"
    )
    .map((route) => ({
      name: route.name,
      agentId: route.agentId,
      targetAddress: route.targetAddress,
      lastUpdated: route.lastUpdated,
    }));

  res.status(200).json({
    success: true,
    count: routes.length,
    subdomains: routes,
  });
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
