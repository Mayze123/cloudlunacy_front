/**
 * Traefik API Routes
 */

const express = require("express");
const router = express.Router();
const traefikController = require("../controllers/traefikController");
const { authMiddleware, adminMiddleware } = require("../middleware/auth");

// Public routes (for health checking)
router.get("/traefik/health", traefikController.getHealth);

// Protected routes (require authentication)
router.get("/traefik/routes", authMiddleware, traefikController.getAllRoutes);
router.get(
  "/traefik/routes/:agentId",
  authMiddleware,
  traefikController.getAgentRoutes
);
router.post(
  "/traefik/routes/http",
  authMiddleware,
  traefikController.addHttpRoute
);
router.post(
  "/traefik/routes/mongodb",
  authMiddleware,
  traefikController.addMongoDBRoute
);
router.delete("/traefik/routes", authMiddleware, traefikController.removeRoute);

// Admin-only routes
router.get(
  "/traefik/stats",
  authMiddleware,
  adminMiddleware,
  traefikController.getStats
);
router.post(
  "/traefik/validate",
  authMiddleware,
  adminMiddleware,
  traefikController.validateConfig
);
router.post(
  "/traefik/recover",
  authMiddleware,
  adminMiddleware,
  traefikController.recoverService
);

module.exports = router;
