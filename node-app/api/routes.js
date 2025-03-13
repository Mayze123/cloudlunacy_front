// api/routes.js
/**
 * API Routes
 *
 * Defines all API routes for the front server.
 * Grouped by functionality: agent, app, mongodb, etc.
 */

const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");

// Import controllers
const agentController = require("./controllers/agentController.js");
const appController = require("./controllers/appController");
const mongodbController = require("./controllers/mongodbController");
const configController = require("./controllers/configController");
const healthController = require("./controllers/healthController");

// Import middleware
const authMiddleware = require("./middleware/auth");
const errorMiddleware = require("./middleware/errorHandler");

// Define routes

/**
 * Agent Management Routes
 */
router.post("/agent/register", agentController.registerAgent);
router.post("/agent/authenticate", agentController.authenticateAgent);
router.get(
  "/agent/list",
  authMiddleware.requireAuth,
  agentController.listAgents
);
router.get(
  "/agent/:agentId",
  authMiddleware.requireAuth,
  agentController.getAgentDetails
);
router.delete(
  "/agent/:agentId",
  authMiddleware.requireAuth,
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
router.post(
  "/app/:agentId",
  authMiddleware.requireAuth,
  appController.registerApp
);
router.get(
  "/app/:agentId/list",
  authMiddleware.requireAuth,
  appController.listApps
);
router.delete(
  "/app/:agentId/:subdomain",
  authMiddleware.requireAuth,
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
  "/mongodb/list",
  authMiddleware.requireAuth,
  mongodbController.listMongoDbs
);
router.post(
  "/mongodb/:agentId",
  authMiddleware.requireAuth,
  mongodbController.registerMongoDB
);
router.get(
  "/mongodb/:agentId/test",
  authMiddleware.requireAuth,
  mongodbController.testMongoDB
);

/**
 * Configuration Management Routes
 */
router.get("/config", authMiddleware.requireAuth, configController.getConfig);
router.get(
  "/frontdoor/config",
  authMiddleware.requireAuth,
  configController.getTraefikConfig
);
router.post(
  "/config/repair",
  authMiddleware.requireAuth,
  configController.repairConfig
);
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

// Apply error handling middleware
router.use(errorMiddleware.handleErrors);

module.exports = router;
