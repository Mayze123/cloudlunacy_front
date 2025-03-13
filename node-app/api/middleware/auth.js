// api/middleware/auth.js
/**
 * Authentication Middleware
 *
 * Handles JWT authentication and authorization for API routes.
 */

const coreServices = require("../../services/core");
const logger = require("../../utils/logger").getLogger("auth");
const { AppError } = require("../../utils/errorHandler");

/**
 * Require authentication for protected routes
 */
exports.requireAuth = (req, res, next) => {
  try {
    // Get authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      logger.warn("Missing Authorization header", { path: req.path });
      return res.status(401).json({ error: "Missing Authorization header" });
    }

    // Extract token
    const [type, token] = authHeader.split(" ");

    if (type !== "Bearer" || !token) {
      logger.warn("Invalid Authorization format", { path: req.path });
      return res.status(401).json({ error: "Invalid Authorization format" });
    }

    // Verify token
    try {
      const decoded = coreServices.agent.verifyAgentToken(token);
      req.user = decoded;
      next();
    } catch (err) {
      logger.warn(`Invalid token: ${err.message}`, { path: req.path });
      return res.status(401).json({ error: "Invalid token" });
    }
  } catch (err) {
    logger.error(`Authentication error: ${err.message}`, {
      error: err.message,
      stack: err.stack,
      path: req.path,
    });
    return res.status(500).json({ error: "Authentication error" });
  }
};

/**
 * Require a specific role
 */
exports.requireRole = (role) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    if (req.user.role !== role) {
      logger.warn("Insufficient permissions", {
        requiredRole: role,
        userRole: req.user.role,
        path: req.path,
      });

      return res.status(403).json({ error: "Insufficient permissions" });
    }

    next();
  };
};

/**
 * Check if user is associated with a specific agent
 */
exports.requireAgentAccess = (paramName = "agentId") => {
  return (req, res, next) => {
    const agentId = req.params[paramName];

    if (!req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    // Admin role can access any agent
    if (req.user.role === "admin") {
      return next();
    }

    // Agent can only access its own resources
    if (req.user.role === "agent" && req.user.agentId !== agentId) {
      logger.warn("Agent attempting to access another agent's resources", {
        agentId: req.user.agentId,
        requestedAgentId: agentId,
        path: req.path,
      });

      return res.status(403).json({ error: "Insufficient permissions" });
    }

    next();
  };
};
