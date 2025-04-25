/**
 * Traefik Controller
 *
 * Controller for Traefik management including:
 * - Route management
 * - Health status and metrics
 */

const logger = require("../../utils/logger").getLogger("traefikController");
const { AppError } = require("../../utils/errorHandler");
const traefikService = require("../../services/core").getTraefikService();

/**
 * Get all Traefik routes
 */
exports.getAllRoutes = async (req, res, next) => {
  try {
    const routes = await traefikService.getAllRoutes();
    res.json(routes);
  } catch (err) {
    next(err);
  }
};

/**
 * Get routes for a specific agent
 */
exports.getAgentRoutes = async (req, res, next) => {
  try {
    const agentId = req.params.agentId;
    const routes = await traefikService.getAgentRoutes(agentId);
    res.json(routes);
  } catch (err) {
    next(err);
  }
};

/**
 * Add a new HTTP route
 */
exports.addHttpRoute = async (req, res, next) => {
  try {
    const { agentId, subdomain, targetUrl } = req.body;

    if (!agentId || !subdomain || !targetUrl) {
      throw new AppError("Missing required parameters", 400);
    }

    const result = await traefikService.addHttpRoute(
      agentId,
      subdomain,
      targetUrl,
      req.body
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
};

/**
 * Add a new MongoDB route
 */
exports.addMongoDBRoute = async (req, res, next) => {
  try {
    const { agentId, targetHost, targetPort } = req.body;

    if (!agentId || !targetHost) {
      throw new AppError("Missing required parameters", 400);
    }

    const result = await traefikService.addMongoDBRoute(
      agentId,
      targetHost,
      targetPort || 27017,
      req.body
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
};

/**
 * Remove a route
 */
exports.removeRoute = async (req, res, next) => {
  try {
    const { agentId, subdomain, type } = req.body;

    if (!agentId) {
      throw new AppError("Agent ID is required", 400);
    }

    if (type === "http" && !subdomain) {
      throw new AppError("Subdomain is required for HTTP routes", 400);
    }

    const result = await traefikService.removeRoute(
      agentId,
      subdomain,
      type || "http"
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
};

/**
 * Get Traefik health status
 */
exports.getHealth = async (req, res, next) => {
  try {
    const forceRefresh = req.query.refresh === "true";

    let health;
    if (forceRefresh) {
      health = await traefikService.performHealthCheck();
    } else {
      health = traefikService.getHealthStatus();
    }

    res.json({
      timestamp: new Date().toISOString(),
      success: health.status === "healthy",
      status: health.status,
      details: health.details,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Try to recover Traefik service after failure
 */
exports.recoverService = async (req, res, next) => {
  try {
    const result = await traefikService.recoverService();
    res.json(result);
  } catch (err) {
    next(err);
  }
};

/**
 * Get Traefik stats
 */
exports.getStats = async (req, res, next) => {
  try {
    const stats = await traefikService.getStats();
    res.json(stats);
  } catch (err) {
    next(err);
  }
};

/**
 * Validate Traefik configuration
 */
exports.validateConfig = async (req, res, next) => {
  try {
    const result = await traefikService.validateConfig();
    res.json(result);
  } catch (err) {
    next(err);
  }
};

/**
 * Diagnose MongoDB connection issues for an agent
 */
exports.diagnoseMongoDBConnection = async (req, res, next) => {
  try {
    const agentId = req.params.agentId || req.query.agentId;

    if (!agentId) {
      throw new AppError("Agent ID is required", 400);
    }

    const result = await traefikService.diagnoseMongoDBConnection(agentId);
    res.json(result);
  } catch (err) {
    next(err);
  }
};
