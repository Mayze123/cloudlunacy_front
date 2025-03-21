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
      return res.status(401).json({
        success: false,
        error: "Missing Authorization header",
      });
    }

    // Extract token
    const parts = authHeader.split(" ");

    if (parts.length !== 2 || parts[0] !== "Bearer") {
      logger.warn("Invalid Authorization format", { path: req.path });
      return res.status(401).json({
        success: false,
        error: "Invalid Authorization format",
      });
    }

    const token = parts[1];

    if (!token) {
      logger.warn("Empty token provided", { path: req.path });
      return res.status(401).json({
        success: false,
        error: "Invalid token",
      });
    }

    // Verify token
    try {
      // Ensure core services are initialized
      if (!coreServices.agent) {
        throw new AppError("Authentication service not available", 503);
      }

      const decoded = coreServices.agent.verifyAgentToken(token);

      if (!decoded || !decoded.agentId) {
        throw new Error("Invalid token payload");
      }

      req.user = decoded;
      next();
    } catch (err) {
      logger.warn(`Invalid token: ${err.message}`, { path: req.path });
      return res.status(401).json({
        success: false,
        error: "Invalid or expired token",
      });
    }
  } catch (err) {
    logger.error(`Authentication error: ${err.message}`, {
      error: err.message,
      stack: err.stack,
      path: req.path,
    });

    // Handle service unavailable separately
    if (err instanceof AppError && err.statusCode === 503) {
      return res.status(503).json({
        success: false,
        error: "Authentication service unavailable",
      });
    }

    return res.status(500).json({
      success: false,
      error: "Authentication error",
    });
  }
};

/**
 * Optional authentication middleware
 * Attempts to authenticate but continues even if authentication fails
 */
exports.optional = (req, res, next) => {
  try {
    // Get authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      // Continue without authentication
      return next();
    }

    // Extract token
    const parts = authHeader.split(" ");

    if (parts.length !== 2 || parts[0] !== "Bearer") {
      // Continue without authentication
      logger.debug("Invalid Authorization format in optional auth", {
        path: req.path,
      });
      return next();
    }

    const token = parts[1];

    if (!token) {
      // Continue without authentication
      logger.debug("Empty token provided in optional auth", { path: req.path });
      return next();
    }

    // Verify token
    try {
      // Ensure core services are initialized
      if (!coreServices.agent) {
        logger.debug("Authentication service not available in optional auth", {
          path: req.path,
        });
        return next();
      }

      const decoded = coreServices.agent.verifyAgentToken(token);

      if (!decoded || !decoded.agentId) {
        logger.debug("Invalid token payload in optional auth", {
          path: req.path,
        });
        return next();
      }

      req.user = decoded;
    } catch (err) {
      // Continue without authentication
      logger.debug(`Optional auth token verification failed: ${err.message}`, {
        path: req.path,
      });
    }

    next();
  } catch (err) {
    // Continue without authentication
    logger.debug(`Optional auth error: ${err.message}`, { path: req.path });
    next();
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
