/**
 * HAProxy Controller
 *
 * Controller for HAProxy management including:
 * - Route management
 * - Health status and metrics
 * - Load optimization and traffic pattern analysis
 */

const logger = require("../../utils/logger").getLogger("haproxyController");
const { AppError } = require("../../utils/errorHandler");
const haproxyService = require("../../services/core").getHAProxyService();

/**
 * Get all HAProxy routes
 */
exports.getAllRoutes = async (req, res, next) => {
  try {
    const routes = await haproxyService.getAllRoutes();
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
    const routes = await haproxyService.getAgentRoutes(agentId);
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
      throw new AppError(
        "Missing required fields (agentId, subdomain, targetUrl)",
        400
      );
    }

    const result = await haproxyService.addHttpRoute(
      agentId,
      subdomain,
      targetUrl,
      req.body
    );
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
};

/**
 * Add a new MongoDB route
 */
exports.addMongodbRoute = async (req, res, next) => {
  try {
    const { agentId, targetHost, targetPort } = req.body;

    if (!agentId || !targetHost) {
      throw new AppError("Missing required fields (agentId, targetHost)", 400);
    }

    const result = await haproxyService.addMongoDBRoute(
      agentId,
      targetHost,
      targetPort,
      req.body
    );
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
};

/**
 * Remove a route
 */
exports.removeRoute = async (req, res, next) => {
  try {
    const { type, agentId, subdomain } = req.params;

    if (!type || !agentId) {
      throw new AppError("Missing required fields (type, agentId)", 400);
    }

    const result = await haproxyService.removeRoute(agentId, subdomain, type);
    res.json(result);
  } catch (err) {
    next(err);
  }
};

/**
 * Update multiple routes in a batch
 */
exports.updateMultipleRoutes = async (req, res, next) => {
  try {
    const { routes } = req.body;

    if (!Array.isArray(routes) || routes.length === 0) {
      throw new AppError("Routes must be a non-empty array", 400);
    }

    const result = await haproxyService.updateMultipleRoutes(routes);
    res.json(result);
  } catch (err) {
    next(err);
  }
};

/**
 * Get HAProxy health status
 */
exports.getHealth = async (req, res, next) => {
  try {
    const forceRefresh = req.query.refresh === "true";
    const health = await haproxyService.getHealthStatus(forceRefresh);
    res.json(health);
  } catch (err) {
    next(err);
  }
};

/**
 * Try to recover HAProxy service after failure
 */
exports.recoverService = async (req, res, next) => {
  try {
    const result = await haproxyService.recoverService();
    res.json(result);
  } catch (err) {
    next(err);
  }
};

/**
 * Get HAProxy stats
 */
exports.getStats = async (req, res, next) => {
  try {
    const stats = await haproxyService.getStats();
    res.json(stats);
  } catch (err) {
    next(err);
  }
};

/**
 * Validate HAProxy configuration
 */
exports.validateConfig = async (req, res, next) => {
  try {
    const result = await haproxyService.validateConfig();
    res.json(result);
  } catch (err) {
    next(err);
  }
};

/**
 * Get current HAProxy metrics
 */
exports.getMetrics = async (req, res, next) => {
  try {
    if (!haproxyService.metricsManager) {
      throw new AppError("Metrics manager not available", 503);
    }

    const metrics = haproxyService.metricsManager.getCurrentMetrics();
    res.json({
      timestamp: new Date().toISOString(),
      metrics,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Get historical HAProxy metrics
 */
exports.getMetricsHistory = async (req, res, next) => {
  try {
    if (!haproxyService.metricsManager) {
      throw new AppError("Metrics manager not available", 503);
    }

    const hours = parseInt(req.query.hours || "6", 10);
    const interval = parseInt(req.query.interval || "5", 10); // minutes

    const history = await haproxyService.metricsManager.getMetricsHistory(
      hours,
      interval
    );
    res.json({
      timestamp: new Date().toISOString(),
      hours,
      interval,
      metrics: history,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Get detected anomalies in HAProxy metrics
 */
exports.getMetricsAnomalies = async (req, res, next) => {
  try {
    if (!haproxyService.metricsManager) {
      throw new AppError("Metrics manager not available", 503);
    }

    const hours = parseInt(req.query.hours || "24", 10);
    const anomalies = await haproxyService.metricsManager.getDetectedAnomalies(
      hours
    );

    res.json({
      timestamp: new Date().toISOString(),
      hours,
      anomalies,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Get HAProxy load optimizer status
 */
exports.getOptimizerStatus = async (req, res, next) => {
  try {
    if (!haproxyService.loadOptimizer) {
      throw new AppError("Load optimizer not available", 503);
    }

    const status = haproxyService.loadOptimizer.getStatus();
    res.json({
      timestamp: new Date().toISOString(),
      status,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Get HAProxy load optimization history
 */
exports.getOptimizationHistory = async (req, res, next) => {
  try {
    if (!haproxyService.loadOptimizer) {
      throw new AppError("Load optimizer not available", 503);
    }

    const limit = parseInt(req.query.limit || "10", 10);
    const history = haproxyService.loadOptimizer.getOptimizationHistory(limit);
    const weightHistory = haproxyService.loadOptimizer.getWeightHistory(limit);

    res.json({
      timestamp: new Date().toISOString(),
      optimizations: history,
      weightChanges: weightHistory,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Trigger immediate HAProxy load optimization
 */
exports.triggerOptimization = async (req, res, next) => {
  try {
    if (!haproxyService.loadOptimizer) {
      throw new AppError("Load optimizer not available", 503);
    }

    const emergency = req.body.emergency === true;
    const result = await haproxyService.loadOptimizer.forceOptimization(
      emergency
    );

    res.json({
      timestamp: new Date().toISOString(),
      emergency,
      result,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Update HAProxy load optimizer settings
 */
exports.updateOptimizerSettings = async (req, res, next) => {
  try {
    if (!haproxyService.loadOptimizer) {
      throw new AppError("Load optimizer not available", 503);
    }

    const settings = req.body;

    // Validate settings
    if (
      settings.algorithm &&
      !["adaptive", "predictive", "balanced"].includes(settings.algorithm)
    ) {
      throw new AppError(
        "Invalid algorithm. Must be one of: adaptive, predictive, balanced",
        400
      );
    }

    if (
      settings.adaptationRate !== undefined &&
      (typeof settings.adaptationRate !== "number" ||
        settings.adaptationRate < 0 ||
        settings.adaptationRate > 1)
    ) {
      throw new AppError(
        "Adaptation rate must be a number between 0 and 1",
        400
      );
    }

    const success = haproxyService.loadOptimizer.updateSettings(settings);

    if (success) {
      const updatedStatus = haproxyService.loadOptimizer.getStatus();
      res.json({
        timestamp: new Date().toISOString(),
        success: true,
        message: "Settings updated successfully",
        settings: updatedStatus,
      });
    } else {
      throw new AppError("Failed to update settings", 400);
    }
  } catch (err) {
    next(err);
  }
};

/**
 * Get traffic patterns for a backend
 */
exports.getTrafficPatterns = async (req, res, next) => {
  try {
    if (!haproxyService.loadOptimizer) {
      throw new AppError("Load optimizer not available", 503);
    }

    const backendName = req.params.backend;
    if (!backendName) {
      throw new AppError("Backend name is required", 400);
    }

    const patterns =
      haproxyService.loadOptimizer.getBackendTrafficPatterns(backendName);

    if (!patterns) {
      throw new AppError(
        `No traffic patterns found for backend: ${backendName}`,
        404
      );
    }

    res.json({
      timestamp: new Date().toISOString(),
      backend: backendName,
      patterns,
    });
  } catch (err) {
    next(err);
  }
};
