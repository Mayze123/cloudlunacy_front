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
      throw new AppError(
        `Failed to register MongoDB: ${result.error}`,
        500
      );
    }

    // At this point we have a successful registration
    const domain = `${agentId}.${
      process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk"
    }`;
    const connectionString = `mongodb://username:password@${domain}:27017/admin?${
      useTls ? "tls=true&tlsAllowInvalidCertificates=true" : ""
    }`;

    // Test the connection to confirm everything is working
    let connectionTest = null;
    try {
      connectionTest = await coreServices.mongodbService.testConnection(
        agentId,
        targetIp
      );
      
      if (!connectionTest.success) {
        logger.warn(
          `MongoDB connection test failed after registration: ${connectionTest.error}`
        );
      } else {
        logger.info(`MongoDB connection test successful for agent ${agentId}`);
      }
    } catch (testErr) {
      logger.warn(`Failed to test MongoDB connection: ${testErr.message}`);
      // Continue anyway, as registration was successful
    }

    // Return success response
    res.status(200).json({
      success: true,
      message: `MongoDB registered successfully`,
      domain,
      connectionString,
      targetIp,
      targetPort,
      tlsEnabled: useTls,
      connectionTestResult: connectionTest || { success: null, message: "Connection test not performed" }
    });
  } catch (error) {
    logger.error(`MongoDB registration error: ${error.message}`);
    throw new AppError(
      `Failed to register MongoDB: ${error.message}`,
      500
    );
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
    connectionInfo = await coreServices.mongodbService.getConnectionInfo(agentId);
  } catch (infoErr) {
    // Continue even if we can't get info - might still be able to deregister
    logger.warn(`Could not get connection info before removal: ${infoErr.message}`);
  }

  // Try to remove MongoDB registration
  const result = await coreServices.mongodbService.deregisterAgent(agentId);

  if (!result.success) {
    logger.error(`Failed to remove MongoDB for agent ${agentId}: ${result.error || 'Unknown error'}`);
    throw new AppError(
      `Failed to remove MongoDB subdomain for agent ${agentId}: ${result.error}`,
      404
    );
  }

  // Return success response
  res.status(200).json({
    success: true,
    message: `MongoDB subdomain for agent ${agentId} removed successfully`
  });
});

/**
 * Test MongoDB connectivity
 *
 * GET /api/mongodb/:agentId/test
 */
exports.testConnection = asyncHandler(async (req, res) => {
  const { agentId } = req.params;
  const { targetIp } = req.query; // Optional override for testing a different IP

  logger.info(`Testing MongoDB connectivity for agent ${agentId}${targetIp ? ` at ${targetIp}` : ''}`);

  // Test MongoDB connectivity
  const result = await coreServices.mongodbService.testConnection(agentId, targetIp);

  // Add diagnostics information
  const diagnostics = {
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    traefikAvailable: !!coreServices.traefikService,
    mongodbPort: process.env.MONGODB_PORT || '27017',
    mongoDomain: process.env.MONGO_DOMAIN || 'mongodb.cloudlunacy.uk'
  };

  // Get routing information if available
  let routingInfo = {};
  try {
    const connectionInfo = await coreServices.mongodbService.getConnectionInfo(agentId);
    if (connectionInfo && connectionInfo.success) {
      routingInfo = {
        domain: connectionInfo.domain,
        lastUpdated: connectionInfo.lastUpdated
      };
    }
  } catch (infoErr) {
    logger.warn(`Could not get routing info during test: ${infoErr.message}`);
  }

  // Combine all details in response
  res.status(200).json({
    success: result.success,
    message: result.message || (result.success ? 'Test completed successfully' : 'Test failed'),
    error: result.error,
    direct: result.direct,
    proxy: result.proxy,
    diagnostics,
    routing: routingInfo,
    recommendations: generateRecommendations(result)
  });
});

/**
 * Generate recommendations based on test results
 * @private
 */
function generateRecommendations(testResult) {
  const recommendations = [];

  if (!testResult.success) {
    recommendations.push('Verify that the MongoDB server is running and accessible.');
  }

  // Direct connection issues
  if (testResult.direct && !testResult.direct.success) {
    const directError = testResult.direct.error || '';
    
    if (directError.includes('ECONNREFUSED')) {
      recommendations.push('The MongoDB server is not running or the port is blocked. Check that MongoDB is running on the target machine.');
    }
    
    if (directError.includes('EHOSTUNREACH') || directError.includes('ENETUNREACH')) {
      recommendations.push('The host is unreachable. Check network connectivity and firewall settings.');
    }
    
    if (directError.includes('timed out')) {
      recommendations.push('Connection timed out. This could be due to network latency, firewall rules, or the server being overloaded.');
    }
  }

  // Proxy connection issues
  if (testResult.proxy && !testResult.proxy.success) {
    const proxyError = testResult.proxy.error || '';
    
    if (proxyError.includes('ECONNREFUSED')) {
      recommendations.push('The proxy cannot connect to the MongoDB server. Check that the proxy configuration is correct.');
    }
    
    if (proxyError.includes('certificate')) {
      recommendations.push('TLS certificate issues detected. Consider temporarily disabling TLS or generating new certificates.');
    }
    
    if (proxyError.includes('DNS')) {
      recommendations.push('DNS resolution failed. Check that the MongoDB domain is properly configured in your DNS or hosts file.');
    }
  }

  // If direct works but proxy doesn't
  if (testResult.direct && testResult.direct.success && 
      testResult.proxy && !testResult.proxy.success) {
    recommendations.push('The MongoDB server is running but proxy routing is not working. Check the proxy configuration and routing rules.');
  }

  // Default recommendations if none were generated
  if (recommendations.length === 0 && !testResult.success) {
    recommendations.push('Try restarting the MongoDB server and the proxy service.');
    recommendations.push('Check the logs for more detailed error information.');
  }

  return recommendations;
}

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
