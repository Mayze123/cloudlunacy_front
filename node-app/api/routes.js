/**
 * API Routes
 *
 * Reorganized API routes with more logical grouping and consistent patterns.
 * Focuses on the core proxy functionality while keeping essential supporting endpoints.
 */

const express = require("express");
const { AppError } = require("../utils/errorHandler");
const { errorMiddleware } = require("../utils/errorHandler");
const authMiddleware = require("./middleware/auth");

// // Import core services  <-- Remove
// const ProxyService = require("../services/core/proxyService");
// const AgentService = require("../services/core/agentService");
// const ConfigService = require("../services/core/configService");

// // Initialize services <-- Remove
// const proxyService = new ProxyService();
// const agentService = new AgentService();
// const configService = new ConfigService();

// // Initialize all services <-- Remove
// (async () => {
//   try {
//     await proxyService.initialize();
//     await agentService.initialize();
//     await configService.initialize();
//   } catch (err) {
//     console.error("Failed to initialize services:", err);
//   }
// })();

// Function to create and configure the router, accepting initialized services
function createApiRouter(coreServices) {
  const router = express.Router();

  const { proxyService, agentService, configService } = coreServices;

  /**
   * Health and Status Routes
   */
  router.get("/health", async (req, res, next) => {
    try {
      // Use the passed-in proxyService
      const proxyHealth = await proxyService.checkHealth();

      res.json({
        success: true,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        services: {
          proxy: proxyHealth,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/health/repair",
    authMiddleware.requireAuth,
    authMiddleware.requireAdmin(),
    async (req, res, next) => {
      try {
        // Use the passed-in proxyService
        const result = await proxyService.repair();
        res.json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * Agent Routes
   */
  router.post("/agents/register", async (req, res, next) => {
    try {
      const { agentId, agentKey, agentName, targetIp } = req.body;

      if (!agentId || !agentKey) {
        throw new AppError("Agent ID and agent key are required", 400);
      }
      // Use the passed-in agentService
      const result = await agentService.registerAgent(
        agentId,
        agentKey,
        agentName,
        targetIp
      );

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post("/agents/authenticate", async (req, res, next) => {
    try {
      const { agentId, agentKey } = req.body;

      if (!agentId || !agentKey) {
        throw new AppError("Agent ID and agent key are required", 400);
      }
      // Use the passed-in agentService
      const result = await agentService.authenticateAgent(agentId, agentKey);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get(
    "/agents/:agentId",
    authMiddleware.requireAuth,
    authMiddleware.requireAgentAccess(),
    async (req, res, next) => {
      try {
        const { agentId } = req.params;
        // Use the passed-in agentService
        const result = await agentService.getAgentInfo(agentId);
        res.json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  router.delete(
    "/agents/:agentId",
    authMiddleware.requireAuth,
    authMiddleware.requireAgentAccess(),
    async (req, res, next) => {
      try {
        const { agentId } = req.params;
        // Use the passed-in agentService
        const result = await agentService.deregisterAgent(agentId);
        res.json(result);
      } catch (err) {
        next(err);
      }
    }
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

        // Use the passed-in proxyService
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

  router.post(
    "/proxy/mongodb",
    authMiddleware.requireAuth,
    async (req, res, next) => {
      try {
        const { agentId, targetHost, targetPort, options } = req.body;

        if (!agentId) {
          throw new AppError("Agent ID is required", 400);
        }

        if (!targetHost) {
          throw new AppError("Target host is required", 400);
        }

        // Use the passed-in proxyService
        const result = await proxyService.addMongoDBRoute(
          agentId,
          targetHost,
          targetPort || 27017,
          options || {}
        );

        res.json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  router.delete(
    "/proxy",
    authMiddleware.requireAuth,
    async (req, res, next) => {
      try {
        const { agentId, subdomain, type } = req.body;

        if (!agentId) {
          throw new AppError("Agent ID is required", 400);
        }

        if (type === "http" && !subdomain) {
          throw new AppError("Subdomain is required for HTTP routes", 400);
        }

        // Use the passed-in proxyService
        const result = await proxyService.removeRoute(
          agentId,
          subdomain,
          type || "http"
        );

        res.json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  router.get(
    "/proxy/agents/:agentId",
    authMiddleware.requireAuth,
    authMiddleware.requireAgentAccess(),
    async (req, res, next) => {
      try {
        const { agentId } = req.params;
        // Use the passed-in proxyService
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
        // Use the passed-in proxyService
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
      // Use the passed-in configService
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
        // Use the passed-in configService
        const result = await configService.getAgentConfig(agentId);
        res.json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  // Apply error handling middleware
  router.use(errorMiddleware);

  return router; // Return the configured router
}

module.exports = createApiRouter; // Export the function
