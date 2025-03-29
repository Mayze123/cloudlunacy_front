// api/routes.js
/**
 * API Routes
 *
 * Defines all API routes for the front server.
 * Grouped by functionality: agent, app, database, etc.
 */

const express = require("express");
const router = express.Router();
const { AppError } = require("../utils/errorHandler");
const coreServices = require("../services/core");

// Import controllers
const agentController = require("./controllers/agentController");
const appController = require("./controllers/appController");
const configController = require("./controllers/configController");
const healthController = require("./controllers/healthController");
const certificateController = require("./controllers/certificateController");

// Import middleware
const authMiddleware = require("./middleware/auth");
const { errorMiddleware } = require("../utils/errorHandler");

// Define routes

/**
 * Agent Management Routes
 */
router.post("/agent/register", agentController.registerAgent);
router.post("/agent/authenticate", agentController.authenticateAgent);
router.get(
  "/agent/:agentId/status",
  authMiddleware.requireAuth,
  authMiddleware.requireAgentAccess(),
  agentController.getAgentStatus
);
router.delete(
  "/agent/:agentId",
  authMiddleware.requireAuth,
  authMiddleware.requireAgentAccess(),
  agentController.deregisterAgent
);

/**
 * App Management Routes
 */
router.post(
  "/frontdoor/add-app",
  authMiddleware.requireAuth,
  appController.addApp
);
router.get("/app", authMiddleware.requireAuth, appController.listApps);
router.delete(
  "/app/:agentId/:subdomain",
  authMiddleware.requireAuth,
  authMiddleware.requireAgentAccess(),
  appController.removeApp
);

/**
 * Configuration Routes
 */
router.get("/config", authMiddleware.requireAuth, configController.getConfig);
router.get(
  "/config/:agentId",
  authMiddleware.requireAuth,
  authMiddleware.requireAgentAccess(),
  configController.getAgentConfig
);
router.post(
  "/config/repair",
  authMiddleware.requireAuth,
  authMiddleware.requireAdmin(),
  configController.repairConfig
);

/**
 * Health Check Routes
 */
router.get("/health", healthController.getHealth);
router.get(
  "/health/mongo",
  authMiddleware.requireAuth,
  healthController.checkMongo
);
router.get(
  "/health/haproxy",
  authMiddleware.requireAuth,
  healthController.checkHAProxy
);
router.post(
  "/health/repair",
  authMiddleware.requireAuth,
  authMiddleware.requireAdmin(),
  healthController.repair
);
router.get(
  "/health/mongodb-listener",
  authMiddleware.requireAuth,
  healthController.checkMongoDBListener
);

/**
 * Certificate Routes
 */
// CA certificate is publicly available
router.get(
  "/certificates/mongodb-ca",
  authMiddleware.optional,
  certificateController.getMongoCA
);

// Agent certificates require authentication
router.get(
  "/certificates/agent/:agentId",
  authMiddleware.requireAuth,
  authMiddleware.requireAgentAccess(),
  certificateController.getAgentCertificates
);

// Regenerate agent certificates and fix HAProxy config
router.post(
  "/certificates/agent/:agentId/regenerate",
  authMiddleware.requireAuth,
  authMiddleware.requireAgentAccess(),
  certificateController.regenerateAgentCertificate
);

// Let's Encrypt certificate issuance/renewal (admin only)
router.post(
  "/certificates/letsencrypt",
  authMiddleware.requireAuth,
  authMiddleware.requireAdmin(),
  certificateController.issueLetsEncryptCert
);

/**
 * Database Routes
 */

// Helper function to get database service and handle errors
const withDatabaseService = (req, res, dbType, callback) => {
  const dbService = coreServices.databaseFactory.getService(dbType);

  if (!dbService) {
    throw new AppError(`Database service '${dbType}' not available`, 503);
  }

  return callback(dbService);
};

// List available database services
router.get("/databases", (req, res) => {
  const dbServices = coreServices.databaseFactory.getAvailableServices();
  res.json({
    success: true,
    databases: dbServices,
  });
});

// Register a database agent with type
router.post("/databases/:dbType/register", async (req, res, next) => {
  try {
    const { dbType } = req.params;
    const { agentId, targetIp, options } = req.body;

    if (!agentId) {
      throw new AppError("Agent ID is required", 400);
    }

    if (!targetIp) {
      throw new AppError("Target IP is required", 400);
    }

    const result = await withDatabaseService(req, res, dbType, (service) =>
      service.registerAgent(agentId, targetIp, options || {})
    );

    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Deregister a database agent with type
router.post("/databases/:dbType/deregister", async (req, res, next) => {
  try {
    const { dbType } = req.params;
    const { agentId } = req.body;

    if (!agentId) {
      throw new AppError("Agent ID is required", 400);
    }

    const result = await withDatabaseService(req, res, dbType, (service) =>
      service.deregisterAgent(agentId)
    );

    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Test connection to a database
router.post("/databases/:dbType/test-connection", async (req, res, next) => {
  try {
    const { dbType } = req.params;
    const { agentId, targetIp } = req.body;

    if (!agentId) {
      throw new AppError("Agent ID is required", 400);
    }

    const result = await withDatabaseService(req, res, dbType, (service) =>
      service.testConnection(agentId, targetIp)
    );

    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Get connection info for a database
router.get("/databases/:dbType/connection/:agentId", async (req, res, next) => {
  try {
    const { dbType, agentId } = req.params;

    if (!agentId) {
      throw new AppError("Agent ID is required", 400);
    }

    const result = await withDatabaseService(req, res, dbType, (service) =>
      service.getConnectionInfo(agentId)
    );

    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Generate credentials for a database
router.post("/databases/:dbType/credentials", async (req, res, next) => {
  try {
    const { dbType } = req.params;
    const { agentId, dbName, username } = req.body;

    if (!agentId) {
      throw new AppError("Agent ID is required", 400);
    }

    const result = await withDatabaseService(req, res, dbType, (service) =>
      service.generateCredentials(agentId, dbName, username)
    );

    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * Routing Routes
 */

// Add an HTTP route
router.post("/routes/http", async (req, res, next) => {
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

    const result = await coreServices.routingService.addHttpRoute(
      agentId,
      subdomain,
      targetUrl,
      options || {}
    );

    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Remove a route
router.delete("/routes", async (req, res, next) => {
  try {
    const { agentId, subdomain, type } = req.body;

    if (!agentId) {
      throw new AppError("Agent ID is required", 400);
    }

    if (!subdomain) {
      throw new AppError("Subdomain is required", 400);
    }

    const result = await coreServices.routingService.removeRoute(
      agentId,
      subdomain,
      type || "http"
    );

    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Get all routes for an agent
router.get("/routes/agent/:agentId", async (req, res, next) => {
  try {
    const { agentId } = req.params;

    if (!agentId) {
      throw new AppError("Agent ID is required", 400);
    }

    const result = await coreServices.routingService.getAgentRoutes(agentId);

    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Get all routes
router.get("/routes", async (req, res, next) => {
  try {
    const result = await coreServices.routingService.getAllRoutes();

    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Apply error handling middleware
router.use(errorMiddleware);

module.exports = router;
