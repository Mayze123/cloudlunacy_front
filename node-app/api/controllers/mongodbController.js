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
 * POST /api/frontdoor/add-subdomain
 * {
 *   "subdomain": "mongodb",
 *   "targetIp": "1.2.3.4",
 *   "agentId": "optional-agent-id"
 * }
 */
exports.addSubdomain = asyncHandler(async (req, res) => {
  const { subdomain, targetIp, agentId } = req.body;

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

  // Register the MongoDB subdomain
  await coreServices.mongodb.registerAgent(agentId || subdomain, targetIp);

  res.status(201).json({
    success: true,
    subdomain: agentId || subdomain,
    domain: `${agentId || subdomain}.${coreServices.mongodb.mongoDomain}`,
    targetIp,
  });
});

/**
 * List all MongoDB subdomains
 *
 * GET /api/mongodb
 */
exports.listSubdomains = asyncHandler(async (req, res) => {
  logger.info("Listing all MongoDB subdomains");

  // Get all TCP routes from cache
  const routes = Array.from(coreServices.routing.routeCache.entries())
    .filter(([key]) => key.startsWith("tcp:") && !key.includes("catchall"))
    .map(([, route]) => ({
      name: route.name,
      domain: extractDomainFromTcpRule(route.rule),
      targetIp: extractTargetFromService(route.service),
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
  const result = await coreServices.mongodb.deregisterAgent(agentId);

  if (!result.success) {
    throw new AppError(
      `Failed to remove MongoDB subdomain for agent ${agentId}`,
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
exports.testMongoDB = asyncHandler(async (req, res) => {
  const { agentId } = req.params;
  const { targetIp } = req.query;

  logger.info(`Testing MongoDB connectivity for agent ${agentId}`);

  // Test MongoDB connectivity
  const result = await coreServices.mongodb.testConnection(agentId, targetIp);

  res.status(200).json(result);
});

// Helper function to extract domain from TCP rule
function extractDomainFromTcpRule(rule) {
  if (!rule) return null;

  const match = rule.match(/HostSNI\(`([^`]+)`\)/);
  return match ? match[1] : null;
}

// Helper function to extract target IP from service
function extractTargetFromService(serviceName) {
  if (!serviceName) return null;

  const service =
    coreServices.config.configs.main?.tcp?.services?.[serviceName];
  if (!service?.loadBalancer?.servers?.length) return null;

  const address = service.loadBalancer.servers[0].address;
  return address ? address.split(":")[0] : null;
}
