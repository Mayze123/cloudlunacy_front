// api/routes.js
/**
 * API Routes
 *
 * Defines all API routes for the front server.
 * Grouped by functionality: agent, app, mongodb, etc.
 */

const express = require("express");
const router = express.Router();

// Import controllers
const agentController = require("./controllers/agentController.js");
const appController = require("./controllers/appController");
const mongodbController = require("./controllers/mongodbController");
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
 * MongoDB Management Routes
 */
router.post(
  "/frontdoor/add-subdomain",
  authMiddleware.requireAuth,
  mongodbController.addSubdomain
);
router.get(
  "/mongodb",
  authMiddleware.requireAuth,
  mongodbController.listSubdomains
);
router.delete(
  "/mongodb/:agentId",
  authMiddleware.requireAuth,
  authMiddleware.requireAgentAccess(),
  mongodbController.removeSubdomain
);
router.get(
  "/mongodb/:agentId/test",
  authMiddleware.requireAuth,
  authMiddleware.requireAgentAccess(),
  mongodbController.testMongoDB
);

/**
 * Configuration Routes
 */
router.get("/config", authMiddleware.requireAuth, configController.getConfig);
router.get(
  "/config/:agentId",
  authMiddleware.requireAuth,
  configController.getAgentConfig
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
  "/health/traefik",
  authMiddleware.requireAuth,
  healthController.checkTraefik
);
router.post(
  "/health/repair",
  authMiddleware.requireAuth,
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
// Fix: Add optional middleware helper function if it doesn't exist
if (!authMiddleware.optional) {
  authMiddleware.optional = (req, res, next) => next();
}

// Fix: Ensure the controller method exists
router.get(
  "/certificates/mongodb-ca",
  authMiddleware.optional,
  certificateController.getMongoCA
);

// Apply error handling middleware
router.use(errorMiddleware);

module.exports = router;
