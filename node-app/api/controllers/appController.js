// api/controllers/appController.js
/**
 * App Controller
 *
 * Handles app registration and management.
 */

const coreServices = require("../../services/core");
const logger = require("../../utils/logger").getLogger("appController");
const { AppError, asyncHandler } = require("../../utils/errorHandler");
const pathManager = require("../../utils/pathManager");

/**
 * Add a new app
 *
 * POST /api/frontdoor/add-app
 * {
 *   "subdomain": "myapp",
 *   "targetUrl": "http://1.2.3.4:8080",
 *   "agentId": "optional-agent-id",
 *   "protocol": "optional-protocol"
 * }
 */
exports.addApp = asyncHandler(async (req, res) => {
  const { subdomain, targetUrl, agentId, protocol } = req.body;

  if (!subdomain || !targetUrl) {
    throw new AppError(
      "Missing required parameters: subdomain and targetUrl are required",
      400,
      { received: { subdomain, targetUrl } }
    );
  }

  logger.info(`Adding app ${subdomain} with target ${targetUrl}`);

  // Add the app route
  const result = await coreServices.routing.addHttpRoute(
    agentId || "default",
    subdomain,
    targetUrl,
    { protocol: protocol || "http" }
  );

  res.status(201).json(result);
});

/**
 * List all apps
 *
 * GET /api/app
 */
exports.listApps = asyncHandler(async (req, res) => {
  logger.info("Listing all apps");

  // Get all HTTP routes from cache
  const routes = Array.from(coreServices.routing.routeCache.entries())
    .filter(([key]) => key.startsWith("http:"))
    .map(([, route]) => ({
      name: route.name,
      domain: route.domain || extractDomainFromRule(route.rule),
      targetUrl: route.targetUrl || extractServiceFromConfig(route.service),
      lastUpdated: route.lastUpdated,
    }));

  res.status(200).json({
    success: true,
    count: routes.length,
    apps: routes,
  });
});

/**
 * Remove an app
 *
 * DELETE /api/app/:agentId/:subdomain
 */
exports.removeApp = asyncHandler(async (req, res) => {
  const { agentId, subdomain } = req.params;

  logger.info(`Removing app ${subdomain} for agent ${agentId}`);

  // Remove the app route
  const result = await coreServices.routing.removeHttpRoute(agentId, subdomain);

  if (!result.success) {
    throw new AppError(`Failed to remove app ${subdomain}`, 404);
  }

  res.status(200).json(result);
});

// Helper function to extract domain from rule
function extractDomainFromRule(rule) {
  if (!rule) return null;

  const match = rule.match(/Host\(`([^`]+)`\)/);
  return match ? match[1] : null;
}

// Helper function to extract service URL from config
function extractServiceFromConfig(serviceName) {
  if (!serviceName) return null;

  const service =
    coreServices.config.configs.main?.http?.services?.[serviceName];
  if (!service?.loadBalancer?.servers?.length) return null;

  return service.loadBalancer.servers[0].url;
}
