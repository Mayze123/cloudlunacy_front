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

// Import core services
const coreServices = require("./services/core");

// Import utilities
const logger = require("./utils/logger");
const { errorMiddleware } = require("./utils/errorHandler");
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
app.use(errorMiddleware);

// Set up graceful shutdown handlers
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
    appLogger.error("Unhandled Promise rejection:", { reason });
    performGracefulShutdown(server);
  });
}

// Perform graceful shutdown
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
    // Initialize core services
    const initialized = await coreServices.initialize();

    if (!initialized) {
      appLogger.error(
        "Failed to initialize core services, server will not start"
      );
      process.exit(1);
    }

    // Start HTTP server
    const server = app.listen(PORT, () => {
      appLogger.info(`CloudLunacy Front Server listening on port ${PORT}`);
    });

    // Setup graceful shutdown handlers
    setupGracefulShutdown(server);

    // Schedule periodic health checks
    const HEALTH_CHECK_INTERVAL = parseInt(
      process.env.HEALTH_CHECK_INTERVAL || "900000",
      10
    ); // Default: 15 minutes
    setInterval(async () => {
      try {
        appLogger.debug("Running periodic health check");

        // Check MongoDB port
        const mongoConfigOk = await coreServices.mongodb.checkMongoDBPort();
        if (!mongoConfigOk) {
          appLogger.warn(
            "MongoDB port not correctly exposed, attempting to fix"
          );
          await coreServices.mongodb.ensureMongoDBPort();
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

    return server;
  } catch (err) {
    appLogger.error("Failed to start server:", {
      error: err.message,
      stack: err.stack,
    });
    process.exit(1);
  }
}

// Start the server if this file is run directly
if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  startServer,
};
