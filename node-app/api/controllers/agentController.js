// api/controllers/agentController.js
/**
 * Agent Controller
 *
 * Handles agent registration, authentication, and management.
 */

const coreServices = require("../../services/core");
const logger = require("../../utils/logger").getLogger("agentController");
const { AppError, asyncHandler } = require("../../utils/errorHandler");

/**
 * Register a new agent
 *
 * POST /api/agent/register
 * {
 *   "agentId": "agent-name",
 *   "serverId": "optional-server-id"
 * }
 */
exports.registerAgent = asyncHandler(async (req, res) => {
  const { agentId } = req.body;

  if (!agentId) {
    throw new AppError("Agent ID is required", 400);
  }

  // Get agent IP from request headers or connection
  const targetIp =
    req.headers["x-forwarded-for"] ||
    req.headers["x-real-ip"] ||
    req.connection.remoteAddress.replace(/^::ffff:/, "");

  logger.info(`Registering agent ${agentId} with IP ${targetIp}`);

  // Register the agent using core service
  const result = await coreServices.agent.registerAgent(agentId, targetIp);

  res.status(201).json({
    success: true,
    agentId,
    token: result.token,
    mongodbUrl: result.mongodbUrl,
    targetIp,
  });
});

/**
 * Authenticate an agent
 *
 * POST /api/agent/authenticate
 * {
 *   "agentId": "agent-name"
 * }
 */
exports.authenticateAgent = asyncHandler(async (req, res) => {
  const { agentId } = req.body;

  if (!agentId) {
    throw new AppError("Agent ID is required", 400);
  }

  logger.info(`Authenticating agent ${agentId}`);

  // Generate a new token for the agent
  const token = coreServices.agent.generateAgentToken(agentId);

  res.status(200).json({
    success: true,
    agentId,
    token,
  });
});

/**
 * Get agent status
 *
 * GET /api/agent/:agentId/status
 */
exports.getAgentStatus = asyncHandler(async (req, res) => {
  const { agentId } = req.params;

  logger.info(`Getting status for agent ${agentId}`);

  // Get agent status
  const agent = coreServices.agent.registeredAgents.get(agentId);

  if (!agent) {
    throw new AppError(`Agent ${agentId} not found`, 404);
  }

  res.status(200).json({
    success: true,
    agentId,
    status: "active",
    lastSeen: agent.lastSeen || agent.registeredAt,
    registeredAt: agent.registeredAt,
  });
});

/**
 * Deregister an agent
 *
 * DELETE /api/agent/:agentId
 */
exports.deregisterAgent = asyncHandler(async (req, res) => {
  const { agentId } = req.params;

  logger.info(`Deregistering agent ${agentId}`);

  // Check if agent exists
  const agent = coreServices.agent.registeredAgents.get(agentId);

  if (!agent) {
    throw new AppError(`Agent ${agentId} not found`, 404);
  }

  // Remove agent from registry
  coreServices.agent.registeredAgents.delete(agentId);

  res.status(200).json({
    success: true,
    agentId,
    message: `Agent ${agentId} deregistered successfully`,
  });
});
