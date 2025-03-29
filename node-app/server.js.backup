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

// Import utilities
const logger = require("./utils/logger");
const pathManager = require("./utils/pathManager");
const { errorMiddleware } = require("./utils/errorHandler");
const appLogger = logger.getLogger("server");

// Import core services
const coreServices = require("./services/core");

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
  process.on("unhandledRejection", (reason, _promise) => {
    appLogger.error("Unhandled Promise rejection:", { reason });
    performGracefulShutdown(server);
  });
}

// Perform graceful shutdown
function performGracefulShutdown(server) {
  appLogger.info("Starting graceful shutdown...");

  // Set a flag to prevent new connections
  const isShuttingDown = true;
  // Use the flag in the app
  app.use((req, res, next) => {
    if (isShuttingDown) {
      res.status(503).send("Service unavailable - server is shutting down");
    } else {
      next();
    }
  });

  // Close the HTTP server
  server.close((err) => {
    if (err) {
      appLogger.error("Error during server close:", {
        error: err.message,
        stack: err.stack,
      });
    } else {
      appLogger.info("HTTP server closed successfully.");
    }

    // Additional cleanup operations here if needed
    try {
      // Cleanup any remaining resources
      appLogger.info("Cleaning up resources...");

      // Example: Close database connections if they exist
      if (coreServices && coreServices.mongodbService) {
        appLogger.info("Closing MongoDB connections...");
        // Add actual cleanup code here
      }

      appLogger.info("Cleanup completed.");
    } catch (cleanupErr) {
      appLogger.error("Error during cleanup:", {
        error: cleanupErr.message,
        stack: cleanupErr.stack,
      });
    }

    process.exit(0);
  });

  // Force exit after timeout if server.close() hangs
  setTimeout(() => {
    appLogger.error(
      "Forced shutdown after timeout - server.close() did not complete in time"
    );
    process.exit(1);
  }, 30000); // 30 seconds timeout
}

// Start the server
async function startServer() {
  try {
    // Initialize path manager first
    await pathManager.initialize();

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

        // Ensure MongoDB port is available
        const mongoConfigOk =
          await coreServices.mongodbService.checkMongoDBPort();
        if (!mongoConfigOk) {
          appLogger.warn(
            "MongoDB port not available, attempting to configure it"
          );
          await coreServices.mongodbService.ensureMongoDBPort();
          appLogger.info("MongoDB port configuration complete");
        } else {
          appLogger.info("MongoDB port already available");
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
