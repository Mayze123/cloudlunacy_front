// api/controllers/mongodbController.js
/**
 * MongoDB Controller
 *
 * Handles MongoDB subdomain registration and management.
 */

const mongodbManager = require("../../services/mongodbManager");
const logger = require("../../utils/logger").getLogger("mongodbController");

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
exports.addSubdomain = async (req, res, next) => {
  try {
    const { subdomain, targetIp, agentId } = req.body;

    if (!subdomain || !targetIp) {
      return res.status(400).json({
        error:
          "Missing required parameters: subdomain and targetIp are required",
        received: { subdomain, targetIp },
      });
    }

    logger.info(`Adding MongoDB subdomain ${subdomain} for IP ${targetIp}`);

    // Use the effective agent ID from either request or JWT
    const effectiveAgentId = agentId || req.user.agentId || "default";

    // Register MongoDB for the agent
    const result = await mongodbManager.registerAgent(
      effectiveAgentId,
      targetIp
    );

    res.status(200).json({
      success: true,
      message: "MongoDB subdomain added successfully with TLS passthrough.",
      details: {
        domain: result.mongodbUrl,
        targetIp: targetIp,
        agentId: effectiveAgentId,
      },
    });
  } catch (err) {
    logger.error(`Failed to add MongoDB subdomain: ${err.message}`, {
      error: err.message,
      stack: err.stack,
      subdomain: req.body.subdomain,
      targetIp: req.body.targetIp,
    });

    next(err);
  }
};

/**
 * List all registered MongoDB instances
 *
 * GET /api/mongodb/list
 */
exports.listMongoDbs = async (req, res, next) => {
  try {
    logger.info("Listing all MongoDB registrations");

    // Get the list of MongoDB registrations
    const result = await mongodbManager.listRegisteredAgents();

    res.status(200).json(result);
  } catch (err) {
    logger.error(`Failed to list MongoDB registrations: ${err.message}`, {
      error: err.message,
      stack: err.stack,
    });

    next(err);
  }
};

/**
 * Register MongoDB for an agent
 *
 * POST /api/mongodb/:agentId
 * {
 *   "targetIp": "1.2.3.4"
 * }
 */
exports.registerMongoDB = async (req, res, next) => {
  try {
    const { agentId } = req.params;
    const { targetIp } = req.body;

    if (!targetIp) {
      return res.status(400).json({
        error: "Target IP is required",
      });
    }

    logger.info(`Registering MongoDB for agent ${agentId} with IP ${targetIp}`);

    // Register MongoDB for the agent
    const result = await mongodbManager.registerAgent(agentId, targetIp);

    res.status(200).json(result);
  } catch (err) {
    logger.error(`Failed to register MongoDB for agent: ${err.message}`, {
      error: err.message,
      stack: err.stack,
      agentId: req.params.agentId,
      targetIp: req.body.targetIp,
    });

    next(err);
  }
};

/**
 * Test MongoDB connectivity
 *
 * GET /api/mongodb/:agentId/test
 */
exports.testMongoDB = async (req, res, next) => {
  try {
    const { agentId } = req.params;
    const { targetIp } = req.query;

    logger.info(`Testing MongoDB connectivity for agent ${agentId}`);

    // Test MongoDB connectivity
    const result = await mongodbManager.testConnection(agentId, targetIp);

    res.status(200).json(result);
  } catch (err) {
    logger.error(`Failed to test MongoDB connectivity: ${err.message}`, {
      error: err.message,
      stack: err.stack,
      agentId: req.params.agentId,
      targetIp: req.query.targetIp,
    });

    next(err);
  }
};
