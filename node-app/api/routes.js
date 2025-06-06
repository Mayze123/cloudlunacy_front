/**
 * API Routes
 *
 * Reorganized API routes with more logical grouping and consistent patterns.
 * Focuses on the core proxy functionality while keeping essential supporting endpoints.
 */

const express = require("express");
const router = express.Router();
const { AppError } = require("../utils/errorHandler");
const { errorMiddleware } = require("../utils/errorHandler");
const authMiddleware = require("./middleware/auth");

// Import route modules
const certificateRoutes = require("./routes/certificate.routes");
const mongodbRoutes = require("./routes/mongodb.routes");
const healthRoutes = require("./routes/health.routes");
const metricsRoutes = require("./routes/metrics.routes");

// Import controllers
const agentController = require("./controllers/agentController");
const certificateController = require("./controllers/certificateController");

// Import core services
const ProxyService = require("../services/core/proxyService");
const AgentService = require("../services/core/agentService");
const ConfigService = require("../services/core/configService");

// Initialize services
const proxyService = new ProxyService();
const agentService = new AgentService();
const configService = new ConfigService();

/**
 * Initialize all services
 */
(async () => {
  try {
    await proxyService.initialize();
    await agentService.initialize();
    await configService.initialize();
  } catch (err) {
    console.error("Failed to initialize services:", err);
  }
})();

// Mount routes
router.use("/health", healthRoutes);
router.use("/metrics", metricsRoutes);
router.use("/certificates", certificateRoutes);
router.use("/mongodb", mongodbRoutes);

/**
 * Agent Routes
 */
// Use the controller implementation for agent registration
router.post("/agent/register", agentController.registerAgent);

// Redirect old endpoint to new one for backward compatibility
router.post("/agents/register", (req, res) => {
  // Add a deprecation warning header
  res.setHeader(
    "X-Deprecated-API",
    "This endpoint is deprecated. Please use /api/agent/register instead."
  );

  // Forward to the controller method
  agentController.registerAgent(req, res);
});

router.post("/agents/authenticate", agentController.authenticateAgent);

router.get(
  "/agents/:agentId",
  authMiddleware.requireAuth,
  authMiddleware.requireAgentAccess(),
  agentController.getAgentStatus
);

router.delete(
  "/agents/:agentId",
  authMiddleware.requireAuth,
  authMiddleware.requireAgentAccess(),
  agentController.deregisterAgent
);

// Additional route for new API style consistency
router.delete(
  "/agent/:agentId",
  authMiddleware.requireAuth,
  authMiddleware.requireAgentAccess(),
  agentController.deregisterAgent
);

/**
 * Proxy Routes
 */
router.post(
  "/proxy/http",
  authMiddleware.requireAuth,
  async (req, res, next) => {
    try {
      const { agentId, subdomain, targetUrl, options } = req.body;

      if (!agentId) {
        throw new AppError("Agent ID is required", 400);
      }

      if (!subdomain) {
        throw new AppError("Subdomain is required", 400);
      }

      if (!targetUrl) {
        throw new AppError("Target URL is required", 400);
      }

      const result = await proxyService.addHttpRoute(
        agentId,
        subdomain,
        targetUrl,
        options || {}
      );

      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

router.delete("/proxy", authMiddleware.requireAuth, async (req, res, next) => {
  try {
    const { agentId, subdomain } = req.body;

    if (!agentId) {
      throw new AppError("Agent ID is required", 400);
    }

    if (!subdomain) {
      throw new AppError("Subdomain is required for HTTP routes", 400);
    }

    const result = await proxyService.removeRoute(agentId, subdomain);

    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get(
  "/proxy/agents/:agentId",
  authMiddleware.requireAuth,
  authMiddleware.requireAgentAccess(),
  async (req, res, next) => {
    try {
      const { agentId } = req.params;
      const result = await proxyService.getAgentRoutes(agentId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/proxy",
  authMiddleware.requireAuth,
  authMiddleware.requireAdmin(),
  async (req, res, next) => {
    try {
      const result = await proxyService.getAllRoutes();
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Configuration Routes
 */
router.get("/config", authMiddleware.requireAuth, async (req, res, next) => {
  try {
    const result = await configService.getConfig();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get(
  "/config/:agentId",
  authMiddleware.requireAuth,
  authMiddleware.requireAgentAccess(),
  async (req, res, next) => {
    try {
      const { agentId } = req.params;
      const result = await configService.getAgentConfig(agentId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// Certificate routes
router.get(
  "/certificates/agent/:agentId",
  //authMiddleware.requireAuth,
  //authMiddleware.requireAgentAccess(),
  certificateController.getAgentCertificates
);

// Temporary endpoint to regenerate certificates for an agent (without auth)
router.post(
  "/certificates/temp-regenerate/:agentId",
  certificateController.tempRegenerateAgentCertificate
);

// Certificate regeneration
router.post(
  "/certificates/agent/:agentId/regenerate",
  authMiddleware.requireAuth,
  authMiddleware.requireAgentAccess(),
  certificateController.regenerateAgentCertificate
);

// Apply error handling middleware
router.use(errorMiddleware);

module.exports = router;
