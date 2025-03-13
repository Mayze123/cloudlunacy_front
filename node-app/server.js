// server.js
/**
 * CloudLunacy Front Server
 *
 * Main entry point for the front server application.
 * Handles routing, agent registration, and MongoDB connections.
 */

require("dotenv").config();
const express = require("express");
const morgan = require("morgan");
const path = require("path");

// Import services
const configManager = require("./services/configManager");
const mongodbManager = require("./services/mongodbManager");
const agentManager = require("./services/agentManager");
const routingManager = require("./services/routingManager");

// Import utilities
const logger = require("./utils/logger");
const appLogger = logger.getLogger("server");

// Import API routes
const routes = require("./api/routes");

// Setup express app
const app = express();
const PORT = process.env.NODE_PORT || 3005;

// Setup middleware
app.use(express.json());
app.use(morgan("combined", { stream: logger.stream }));

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// API routes
app.use("/api", routes);

// Error handler middleware
app.use((err, req, res, next) => {
  appLogger.error("Unhandled error", {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  res.status(err.status || 500).json({
    error: err.message || "Internal Server Error",
  });
});

// Initialize services sequentially
async function initializeServices() {
  try {
    appLogger.info("Initializing services...");

    // Initialize config manager first
    await configManager.initialize();
    appLogger.info("Configuration manager initialized");

    // Initialize MongoDB manager
    await mongodbManager.initialize();
    appLogger.info("MongoDB manager initialized");

    // Initialize agent manager
    await agentManager.initialize();
    appLogger.info("Agent manager initialized");

    // Initialize routing manager
    await routingManager.initialize();
    appLogger.info("Routing manager initialized");

    appLogger.info("All services initialized successfully");
    return true;
  } catch (err) {
    appLogger.error("Failed to initialize services", {
      error: err.message,
      stack: err.stack,
    });

    // Try to recover
    appLogger.info("Attempting recovery...");

    try {
      // Repair configurations
      await configManager.repairAllConfigurations();
      appLogger.info("Configuration repaired successfully");

      return true;
    } catch (recoveryErr) {
      appLogger.error("Recovery failed", {
        error: recoveryErr.message,
        stack: recoveryErr.stack,
      });

      return false;
    }
  }
}

// Setup graceful shutdown
function setupGracefulShutdown(server) {
  // Handle SIGTERM signal (e.g., from Docker or Kubernetes)
  process.on("SIGTERM", () => {
    appLogger.info("SIGTERM signal received. Shutting down gracefully...");
    performGracefulShutdown(server);
  });

  // Handle SIGINT signal (e.g., Ctrl+C)
  process.on("SIGINT", () => {
    appLogger.info("SIGINT signal received. Shutting down gracefully...");
    performGracefulShutdown(server);
  });

  // Handle uncaught exceptions
  process.on("uncaughtException", (error) => {
    appLogger.error("Uncaught exception:", {
      error: error.message,
      stack: error.stack,
    });
    performGracefulShutdown(server);
  });

  // Handle unhandled promise rejections
  process.on("unhandledRejection", (reason, promise) => {
    appLogger.error("Unhandled Promise rejection:", {
      reason: String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    performGracefulShutdown(server);
  });
}

// Perform the actual graceful shutdown process
function performGracefulShutdown(server) {
  appLogger.info("Starting graceful shutdown...");

  // Close the HTTP server
  server.close(() => {
    appLogger.info("HTTP server closed.");
    process.exit(0);
  });

  // Force exit after timeout if server.close() hangs
  setTimeout(() => {
    appLogger.error("Forced shutdown after timeout");
    process.exit(1);
  }, 30000); // 30 seconds timeout
}

// Start the server
async function startServer() {
  try {
    // Initialize services
    const initialized = await initializeServices();

    if (!initialized) {
      appLogger.error("Failed to initialize services, server will not start");
      process.exit(1);
    }

    // Start HTTP server
    const server = app.listen(PORT, () => {
      appLogger.info(`CloudLunacy Front Server listening on port ${PORT}`);
    });

    // Setup graceful shutdown handlers
    setupGracefulShutdown(server);

    // Log system info
    appLogger.info(`Environment: ${process.env.NODE_ENV || "development"}`);
    appLogger.info(
      `App Domain: ${process.env.APP_DOMAIN || "apps.cloudlunacy.uk"}`
    );
    appLogger.info(
      `MongoDB Domain: ${process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk"}`
    );

    // Set up periodic health checks
    scheduleHealthChecks();

    return server;
  } catch (err) {
    appLogger.error("Failed to start server", {
      error: err.message,
      stack: err.stack,
    });
    process.exit(1);
  }
}

// Schedule periodic health checks
function scheduleHealthChecks() {
  const HEALTH_CHECK_INTERVAL =
    process.env.HEALTH_CHECK_INTERVAL || 5 * 60 * 1000; // 5 minutes

  setInterval(async () => {
    try {
      appLogger.debug("Running periodic health check");

      // Check MongoDB configuration
      const mongoConfigOk = await mongodbManager.checkMongoDBPort();
      if (!mongoConfigOk) {
        appLogger.warn("MongoDB port not correctly exposed, attempting to fix");
        await mongodbManager.ensureMongoDBPort();
      }

      appLogger.debug("Health check completed");
    } catch (err) {
      appLogger.error("Error during periodic health check", {
        error: err.message,
        stack: err.stack,
      });
    }
  }, HEALTH_CHECK_INTERVAL);

  appLogger.info(
    `Scheduled health checks every ${HEALTH_CHECK_INTERVAL / 60000} minutes`
  );
}

// Start the server if this file is run directly
if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  startServer,
};
