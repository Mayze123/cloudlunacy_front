/* global process */
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
 *   "agentId": "agent-name"
 * }
 */
exports.registerAgent = asyncHandler(async (req, res) => {
  const { agentId } = req.body;

  if (!agentId) {
    throw new AppError("Agent ID is required", 400);
  }

  // Validate agent ID format (alphanumeric and hyphens only)
  const validAgentIdPattern = /^[a-zA-Z0-9-]+$/;
  if (!validAgentIdPattern.test(agentId)) {
    throw new AppError(
      "Agent ID must contain only alphanumeric characters and hyphens",
      400
    );
  }

  // Get agent IP from request headers or connection
  let targetIp =
    req.headers["x-forwarded-for"] ||
    req.headers["x-real-ip"] ||
    req.headers["x-agent-ip"] ||
    req.connection.remoteAddress ||
    "";

  // Clean up IPv6 prefix if present and extract first IP if multiple
  if (targetIp) {
    // Extract first IP if there are multiple IPs in x-forwarded-for
    targetIp = targetIp.split(",")[0].trim();

    // Remove IPv6 prefix
    targetIp = targetIp.replace(/^::ffff:/, "");

    // Validate IP format
    if (!isValidIP(targetIp)) {
      logger.warn(`Invalid IP format detected: ${targetIp}, using fallback`);
      targetIp = "127.0.0.1"; // Fallback to localhost if invalid
    }
  } else {
    targetIp = "127.0.0.1"; // Default fallback
  }

  logger.info(`Registering agent ${agentId} with IP ${targetIp}`);

  try {
    // Check if agent already exists
    if (coreServices.agentService.agents.has(agentId)) {
      // Agent exists - this might be a re-registration
      logger.info(
        `Agent ${agentId} already registered, processing as a re-registration`
      );
    }

    // Register the agent using core service
    const result = await coreServices.agentService.registerAgent(
      agentId,
      targetIp,
      {
        useTls: true,
        generateCertificates: true,
      }
    );

    // Build response based on certificate generation results
    const response = {
      success: true,
      agentId,
      token: result.token,
      targetIp,
      tlsEnabled: result.tlsEnabled,
    };

    // Add certificates if they were generated successfully
    if (result.certificates) {
      response.certificates = result.certificates;
    }

    // Include certificate warnings if applicable
    if (result.certificateError) {
      response.warning = "Certificate generation encountered issues";
      response.certificateError = result.certificateError;

      // Log warning for observability
      logger.warn(
        `Agent ${agentId} registered successfully, but certificate generation had issues: ${result.certificateError}`
      );
    }

    res.status(201).json(response);
  } catch (err) {
    logger.error(`Agent registration failed: ${err.message}`, {
      error: err.message,
      stack: err.stack,
      agentId,
      targetIp,
    });

    throw new AppError(`Agent registration failed: ${err.message}`, 500);
  }
});

/**
 * Helper function to validate IP address format
 * @param {string} ip - IP address to validate
 * @returns {boolean} - Whether the IP address is valid
 */
function isValidIP(ip) {
  if (!ip || typeof ip !== "string") {
    return false;
  }

  // IPv4 validation
  // More strict IPv4 regex to properly validate each octet (0-255)
  const ipv4Regex =
    /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

  // IPv6 validation (simplified but covers most cases)
  const ipv6Regex =
    /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::1$|^::$|^([0-9a-fA-F]{1,4}:){0,6}::([0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}$/;

  return ipv4Regex.test(ip) || ipv6Regex.test(ip);
}

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
  const token = coreServices.agentService.generateAgentToken(agentId);

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
  const agent = coreServices.agentService.agents.get(agentId);

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

  if (!agentId) {
    throw new AppError("Agent ID is required", 400);
  }

  logger.info(`Deregistering agent ${agentId}`);

  try {
    // Check if agent exists
    const agent = coreServices.agentService.agents.get(agentId);

    if (!agent) {
      throw new AppError(`Agent ${agentId} not found`, 404);
    }

    // Attempt to clean up any resources before removing the agent
    try {
      // Remove MongoDB routing if it exists
      if (coreServices.mongodbService) {
        await coreServices.mongodbService.deregisterAgent(agentId);
        logger.info(`Removed MongoDB routing for agent ${agentId}`);
      }
    } catch (cleanupErr) {
      // Log but continue with deregistration
      logger.warn(
        `Error cleaning up resources for agent ${agentId}: ${cleanupErr.message}`,
        {
          error: cleanupErr.message,
          stack: cleanupErr.stack,
        }
      );
    }

    // Use the new unregisterAgent method which handles Consul and config updates
    const unregisterResult = await coreServices.agentService.unregisterAgent(
      agentId
    );

    if (!unregisterResult) {
      throw new AppError(`Failed to unregister agent ${agentId}`, 500);
    }

    logger.info(`Agent ${agentId} deregistered successfully`);

    res.status(200).json({
      success: true,
      agentId,
      message: `Agent ${agentId} deregistered successfully`,
    });
  } catch (err) {
    logger.error(`Failed to deregister agent ${agentId}: ${err.message}`, {
      error: err.message,
      stack: err.stack,
    });

    throw new AppError(
      `Failed to deregister agent: ${err.message}`,
      err.statusCode || 500,
      { agentId }
    );
  }
});
