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

  let result;
  // First try to use the AppRegistrationService
  if (
    coreServices.appRegistrationService &&
    coreServices.appRegistrationService.initialized
  ) {
    result = await coreServices.appRegistrationService.registerApp(
      agentId || "default",
      subdomain,
      targetUrl,
      { protocol: protocol || "http" }
    );
  } else {
    // Fallback to the ProxyService if AppRegistrationService is not available
    logger.info(
      "AppRegistrationService not initialized, falling back to ProxyService"
    );
    result = await coreServices.proxyService.addHttpRoute(
      agentId || "default",
      subdomain,
      targetUrl,
      { protocol: protocol || "http" }
    );
  }

  res.status(201).json(result);
});

/**
 * List all apps
 *
 * GET /api/app
 */
exports.listApps = asyncHandler(async (req, res) => {
  logger.info("Listing all apps");

  let apps = [];
  // First try to use the AppRegistrationService
  if (
    coreServices.appRegistrationService &&
    coreServices.appRegistrationService.initialized
  ) {
    apps = await coreServices.appRegistrationService.getAllApps();
  } else {
    // Fallback to the ProxyService if AppRegistrationService is not available
    logger.info(
      "AppRegistrationService not initialized, falling back to ProxyService"
    );
    const result = await coreServices.proxyService.getAllRoutes();
    if (result && result.success && result.routes) {
      // Filter to only include HTTP routes
      apps = result.routes.filter((route) => route.type === "http");
    }
  }

  res.status(200).json({
    success: true,
    count: apps.length,
    apps: apps,
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

  let result;
  // First try to use the AppRegistrationService
  if (
    coreServices.appRegistrationService &&
    coreServices.appRegistrationService.initialized
  ) {
    result = await coreServices.appRegistrationService.unregisterApp(
      agentId,
      subdomain
    );
  } else {
    // Fallback to the ProxyService if AppRegistrationService is not available
    logger.info(
      "AppRegistrationService not initialized, falling back to ProxyService"
    );
    result = await coreServices.proxyService.removeRoute(agentId, subdomain);
  }

  if (!result.success) {
    throw new AppError(`Failed to remove app ${subdomain}`, 404);
  }

  res.status(200).json(result);
});

// Helper function to extract domain from rule (kept for backward compatibility)
function extractDomainFromRule(rule) {
  if (!rule) return null;

  const match = rule.match(/Host\(`([^`]+)`\)/);
  return match ? match[1] : null;
}

// Helper function to extract service URL from config
function extractServiceFromConfig(serviceName) {
  if (!serviceName) return null;

  const service =
    coreServices.configService.configs.main?.http?.services?.[serviceName];
  if (!service?.loadBalancer?.servers?.length) return null;

  return service.loadBalancer.servers[0].url;
}
