/**
 * CloudLunacy Front Door Service
 *
 * Standalone service for adding HTTP and MongoDB routes.
 * This is a compatibility layer for older clients.
 */

require("dotenv").config();
const express = require("express");
const morgan = require("morgan");
const logger = require("./utils/logger").getLogger("frontdoorService");
const coreServices = require("./services/core");

// Initialize express app
const app = express();
const PORT = process.env.FRONTDOOR_PORT || 3006;

// Middleware
app.use(express.json());
app.use(morgan("combined", { stream: logger.stream }));

// Initialize core services
async function initializeServices() {
  try {
    logger.info("Initializing core services for frontdoor service");
    const initialized = await coreServices.initialize();

    if (!initialized) {
      logger.error("Failed to initialize core services");
      process.exit(1);
    }

    logger.info("Core services initialized successfully");
    return true;
  } catch (err) {
    logger.error(`Failed to initialize services: ${err.message}`, {
      error: err.message,
      stack: err.stack,
    });
    process.exit(1);
  }
}

// Add HTTP route endpoint
app.post("/add-app", async (req, res) => {
  try {
    const { subdomain, targetUrl, agentId } = req.body;

    if (!subdomain || !targetUrl) {
      return res.status(400).json({
        success: false,
        error:
          "Missing required parameters: subdomain and targetUrl are required",
      });
    }

    logger.info(`Adding app ${subdomain} with target ${targetUrl}`);

    // Add the app route using core service
    const result = await coreServices.routing.addHttpRoute(
      agentId || "default",
      subdomain,
      targetUrl
    );

    res.status(201).json(result);
  } catch (err) {
    logger.error(`Failed to add app: ${err.message}`, {
      error: err.message,
      stack: err.stack,
    });

    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// Add MongoDB subdomain endpoint
app.post("/add-subdomain", async (req, res) => {
  try {
    const { subdomain, targetIp, agentId } = req.body;

    if (!subdomain || !targetIp) {
      return res.status(400).json({
        success: false,
        error:
          "Missing required parameters: subdomain and targetIp are required",
      });
    }

    logger.info(
      `Adding MongoDB subdomain ${subdomain} with target IP ${targetIp}`
    );

    // Register MongoDB using core service
    const result = await coreServices.mongodb.registerAgent(
      agentId || subdomain,
      targetIp
    );

    res.status(201).json(result);
  } catch (err) {
    logger.error(`Failed to add MongoDB subdomain: ${err.message}`, {
      error: err.message,
      stack: err.stack,
    });

    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "frontdoor",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Start the server
async function startServer() {
  try {
    // Initialize services first
    await initializeServices();

    // Start the server
    app.listen(PORT, () => {
      logger.info(`Front Door Service listening on port ${PORT}`);
    });
  } catch (err) {
    logger.error(`Failed to start server: ${err.message}`, {
      error: err.message,
      stack: err.stack,
    });
    process.exit(1);
  }
}

// Handle uncaught exceptions
process.on("uncaughtException", (err) => {
  logger.error(`Uncaught exception: ${err.message}`, {
    error: err.message,
    stack: err.stack,
  });

  // Exit with error
  process.exit(1);
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  logger.error(`Unhandled promise rejection: ${reason}`, {
    reason,
    stack: reason.stack,
  });

  // Exit with error
  process.exit(1);
});

// Start the server if this file is run directly
if (require.main === module) {
  startServer();
}

module.exports = app;
