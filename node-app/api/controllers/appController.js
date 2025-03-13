// api/controllers/appController.js
/**
 * App Controller
 *
 * Handles app registration and management.
 */

const routingManager = require("../../services/routingManager");
const agentManager = require("../../services/agentManager");
const logger = require("../../utils/logger").getLogger("appController");

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
exports.addApp = async (req, res, next) => {
  try {
    const { subdomain, targetUrl, agentId, protocol } = req.body;

    if (!subdomain || !targetUrl) {
      return res.status(400).json({
        error:
          "Missing required parameters: subdomain and targetUrl are required",
        received: { subdomain, targetUrl },
      });
    }

    logger.info(`Adding app ${subdomain} for target ${targetUrl}`);

    // Use the effective agent ID from either request or JWT
    const effectiveAgentId = agentId || req.user.agentId || "default";

    // Add HTTP route
    const result = await routingManager.addHttpRoute(
      effectiveAgentId,
      subdomain,
      targetUrl,
      { protocol: protocol || "http" }
    );

    res.status(200).json({
      success: true,
      message: "App subdomain added successfully.",
      details: {
        domain: result.domain,
        targetUrl: result.targetUrl,
        agentId: effectiveAgentId,
      },
    });
  } catch (err) {
    logger.error(`Failed to add app: ${err.message}`, {
      error: err.message,
      stack: err.stack,
      subdomain: req.body.subdomain,
      targetUrl: req.body.targetUrl,
    });

    next(err);
  }
};

/**
 * Register app for an agent
 *
 * POST /api/app/:agentId
 * {
 *   "subdomain": "myapp",
 *   "targetUrl": "http://1.2.3.4:8080",
 *   "protocol": "optional-protocol"
 * }
 */
exports.registerApp = async (req, res, next) => {
  try {
    const { agentId } = req.params;
    const { subdomain, targetUrl, protocol } = req.body;

    if (!subdomain || !targetUrl) {
      return res.status(400).json({
        error: "Subdomain and target URL are required",
      });
    }

    logger.info(
      `Registering app ${subdomain} for agent ${agentId} with target ${targetUrl}`
    );

    // Register app for the agent
    const result = await agentManager.registerApp(agentId, {
      subdomain,
      targetUrl,
      protocol: protocol || "http",
    });

    res.status(200).json(result);
  } catch (err) {
    logger.error(`Failed to register app for agent: ${err.message}`, {
      error: err.message,
      stack: err.stack,
      agentId: req.params.agentId,
      subdomain: req.body.subdomain,
      targetUrl: req.body.targetUrl,
    });

    next(err);
  }
};

/**
 * List apps for an agent
 *
 * GET /api/app/:agentId/list
 */
exports.listApps = async (req, res, next) => {
  try {
    const { agentId } = req.params;

    logger.info(`Listing apps for agent ${agentId}`);

    // Get the list of apps for the agent
    const result = await routingManager.listRoutes({
      agentId,
      type: "http",
    });

    res.status(200).json(result);
  } catch (err) {
    logger.error(`Failed to list apps for agent: ${err.message}`, {
      error: err.message,
      stack: err.stack,
      agentId: req.params.agentId,
    });

    next(err);
  }
};

/**
 * Remove an app
 *
 * DELETE /api/app/:agentId/:subdomain
 */
exports.removeApp = async (req, res, next) => {
  try {
    const { agentId, subdomain } = req.params;

    logger.info(`Removing app ${subdomain} for agent ${agentId}`);

    // Remove the app
    const result = await routingManager.removeRoute(agentId, subdomain, "http");

    res.status(200).json(result);
  } catch (err) {
    logger.error(`Failed to remove app: ${err.message}`, {
      error: err.message,
      stack: err.stack,
      agentId: req.params.agentId,
      subdomain: req.params.subdomain,
    });

    next(err);
  }
};
