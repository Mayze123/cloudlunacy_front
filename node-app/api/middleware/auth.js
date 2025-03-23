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
      logger.warn("Missing Authorization header", {
        path: req.path,
        ip: req.ip,
        method: req.method,
      });
      return res.status(401).json({
        success: false,
        error:
          "Authentication required. Please include an Authorization header.",
        code: "MISSING_AUTH_HEADER",
      });
    }

    // Extract token
    const parts = authHeader.split(" ");

    if (parts.length !== 2 || parts[0] !== "Bearer") {
      logger.warn("Invalid Authorization format", {
        path: req.path,
        format: authHeader.substring(0, 20), // Log part of header for debugging (avoiding full token)
        ip: req.ip,
        method: req.method,
      });
      return res.status(401).json({
        success: false,
        error: "Invalid Authorization format. Use 'Bearer <token>'",
        code: "INVALID_AUTH_FORMAT",
      });
    }

    const token = parts[1];

    if (!token) {
      logger.warn("Empty token provided", {
        path: req.path,
        ip: req.ip,
        method: req.method,
      });
      return res.status(401).json({
        success: false,
        error: "Invalid token. Token cannot be empty",
        code: "EMPTY_TOKEN",
      });
    }

    // Verify token
    try {
      // Ensure core services are initialized
      if (!coreServices.agentService) {
        logger.error("Authentication service not available", {
          path: req.path,
          ip: req.ip,
          method: req.method,
        });
        throw new AppError("Authentication service not available", 503);
      }

      const decoded = coreServices.agentService.verifyAgentToken(token);

      if (!decoded || !decoded.agentId) {
        logger.warn("Token payload missing required fields", {
          path: req.path,
          ip: req.ip,
          method: req.method,
        });
        throw new Error("Invalid token payload");
      }

      // Update last seen timestamp if agent exists
      if (
        decoded.agentId &&
        coreServices.agentService.agents.has(decoded.agentId)
      ) {
        const agent = coreServices.agentService.agents.get(decoded.agentId);
        if (agent) {
          agent.lastSeen = new Date().toISOString();
        }
      }

      req.user = decoded;
      next();
    } catch (err) {
      // Handle specific JWT errors
      let errorMessage = "Invalid or expired token";
      const statusCode = 401;
      let errorCode = "INVALID_TOKEN";

      if (err.name === "TokenExpiredError") {
        errorMessage = "Token has expired. Please obtain a new token.";
        errorCode = "TOKEN_EXPIRED";
      } else if (err.name === "JsonWebTokenError") {
        errorMessage =
          "Invalid token. Token is malformed or signature is invalid.";
        errorCode = "TOKEN_INVALID";
      }

      logger.warn(`Token verification failed: ${err.message}`, {
        path: req.path,
        error: err.name,
        ip: req.ip,
        method: req.method,
      });

      return res.status(statusCode).json({
        success: false,
        error: errorMessage,
        code: errorCode,
      });
    }
  } catch (err) {
    logger.error(`Authentication error: ${err.message}`, {
      error: err.message,
      stack: err.stack,
      path: req.path,
      ip: req.ip,
      method: req.method,
    });

    // Handle service unavailable separately
    if (err instanceof AppError && err.statusCode === 503) {
      return res.status(503).json({
        success: false,
        error: "Authentication service unavailable",
        code: "AUTH_SERVICE_UNAVAILABLE",
      });
    }

    return res.status(500).json({
      success: false,
      error: "Internal server error during authentication",
      code: "AUTH_INTERNAL_ERROR",
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
      if (!coreServices.agentService) {
        logger.debug("Authentication service not available in optional auth", {
          path: req.path,
        });
        return next();
      }

      const decoded = coreServices.agentService.verifyAgentToken(token);

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

// Add convenience methods for common role requirements
exports.requireAdmin = () => exports.requireRole("admin");
