// api/controllers/agentController.js
/**
 * Agent Controller
 *
 * Handles agent registration, authentication, and management.
 */

const agentManager = require("../../services/agentManager");
const logger = require("../../utils/logger").getLogger("agentController");

/**
 * Register a new agent
 *
 * POST /api/agent/register
 * {
 *   "agentId": "agent-name",
 *   "serverId": "optional-server-id"
 * }
 */
exports.registerAgent = async (req, res, next) => {
  try {
    const { agentId } = req.body;

    if (!agentId) {
      return res.status(400).json({
        error: "Agent ID is required",
      });
    }

    // Get agent IP from request headers or connection
    const agentIP =
      req.headers["x-agent-ip"] ||
      req.headers["x-forwarded-for"] ||
      req.connection.remoteAddress;

    const cleanIP = agentIP.replace(/^.*:/, ""); // Handle IPv6 format

    logger.info(`Registering agent ${agentId} with IP ${cleanIP}`);

    // Register the agent
    const result = await agentManager.registerAgent(agentId, cleanIP);

    // Return success response
    res.status(200).json({
      token: result.token,
      message: `Agent ${agentId} registered successfully`,
      mongodbUrl: result.mongodbUrl,
    });
  } catch (err) {
    logger.error(`Agent registration failed: ${err.message}`, {
      error: err.message,
      stack: err.stack,
      agentId: req.body.agentId,
    });

    next(err);
  }
};

/**
 * Authenticate an agent
 *
 * POST /api/agent/authenticate
 * {
 *   "agentToken": "token",
 *   "serverId": "server-id"
 * }
 */
exports.authenticateAgent = async (req, res, next) => {
  try {
    const { agentToken, serverId } = req.body;

    if (!agentToken) {
      return res.status(400).json({
        error: "Agent token is required",
      });
    }

    logger.info(`Authenticating agent with server ID ${serverId}`);

    try {
      // Verify the token
      const decoded = agentManager.verifyAgentToken(agentToken);

      // Construct WebSocket URL
      const protocol = req.secure ? "wss" : "ws";
      const host = req.get("host");
      const wsUrl = `${protocol}://${host}/ws/agent/${decoded.agentId}`;

      res.status(200).json({
        agentId: decoded.agentId,
        wsUrl,
        authenticated: true,
      });
    } catch (authError) {
      logger.warn(`Authentication failed: ${authError.message}`);

      res.status(401).json({
        error: "Authentication failed",
        message: authError.message,
      });
    }
  } catch (err) {
    logger.error(`Agent authentication error: ${err.message}`, {
      error: err.message,
      stack: err.stack,
    });

    next(err);
  }
};

/**
 * List all registered agents
 *
 * GET /api/agent/list
 */
exports.listAgents = async (req, res, next) => {
  try {
    logger.info("Listing all registered agents");

    // Get the list of agents
    const result = await agentManager.listAgents();

    res.status(200).json(result);
  } catch (err) {
    logger.error(`Failed to list agents: ${err.message}`, {
      error: err.message,
      stack: err.stack,
    });

    next(err);
  }
};

/**
 * Get agent details
 *
 * GET /api/agent/:agentId
 */
exports.getAgentDetails = async (req, res, next) => {
  try {
    const { agentId } = req.params;

    logger.info(`Getting details for agent ${agentId}`);

    // Get agent details
    const result = await agentManager.getAgentDetails(agentId);

    if (!result.success) {
      return res.status(404).json({
        error: result.error || `Agent ${agentId} not found`,
      });
    }

    res.status(200).json(result);
  } catch (err) {
    logger.error(`Failed to get agent details: ${err.message}`, {
      error: err.message,
      stack: err.stack,
      agentId: req.params.agentId,
    });

    next(err);
  }
};

/**
 * Deregister an agent
 *
 * DELETE /api/agent/:agentId
 */
exports.deregisterAgent = async (req, res, next) => {
  try {
    const { agentId } = req.params;

    logger.info(`Deregistering agent ${agentId}`);

    // Deregister the agent
    const result = await agentManager.deregisterAgent(agentId);

    if (!result.success) {
      return res.status(404).json({
        error: result.error || `Failed to deregister agent ${agentId}`,
      });
    }

    res.status(200).json(result);
  } catch (err) {
    logger.error(`Failed to deregister agent: ${err.message}`, {
      error: err.message,
      stack: err.stack,
      agentId: req.params.agentId,
    });

    next(err);
  }
};
