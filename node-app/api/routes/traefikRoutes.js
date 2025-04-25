/**
 * Traefik API Routes
 */

const express = require("express");
const router = express.Router();
const traefikController = require("../controllers/traefikController");
const authMiddleware = require("../middleware/auth");

// Public routes (for health checking)
router.get("/traefik/health", traefikController.getHealth);

// Test route without auth (for development/testing only)
router.get("/traefik/routes/test", traefikController.getAllRoutes);
router.get(
  "/traefik/mongodb/diagnose/:agentId",
  traefikController.diagnoseMongoDBConnection
);

// Protected routes (require authentication)
router.get(
  "/traefik/routes",
  authMiddleware.requireAuth,
  traefikController.getAllRoutes
);
router.get(
  "/traefik/routes/:agentId",
  authMiddleware.requireAuth,
  traefikController.getAgentRoutes
);
router.post(
  "/traefik/routes/http",
  authMiddleware.requireAuth,
  traefikController.addHttpRoute
);
router.post(
  "/traefik/routes/mongodb",
  authMiddleware.requireAuth,
  traefikController.addMongoDBRoute
);
router.delete(
  "/traefik/routes",
  authMiddleware.requireAuth,
  traefikController.removeRoute
);

// Admin-only routes
router.get(
  "/traefik/stats",
  authMiddleware.requireAuth,
  authMiddleware.requireAdmin,
  traefikController.getStats
);
router.post(
  "/traefik/validate",
  authMiddleware.requireAuth,
  authMiddleware.requireAdmin,
  traefikController.validateConfig
);
router.post(
  "/traefik/recover",
  authMiddleware.requireAuth,
  authMiddleware.requireAdmin,
  traefikController.recoverService
);

module.exports = router;
