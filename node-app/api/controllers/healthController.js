// api/controllers/healthController.js
/**
 * Health Controller
 *
 * Handles health checks and monitoring.
 */

const os = require("os");
const { exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);
const coreServices = require("../../services/core");
const logger = require("../../utils/logger").getLogger("healthController");
const { AppError, asyncHandler } = require("../../utils/errorHandler");

/**
 * Get system health
 *
 * GET /api/health
 */
exports.getHealth = asyncHandler(async (req, res) => {
  logger.debug("Health check requested");

  // Collect system health metrics
  const health = {
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage(),
    system: {
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      hostname: os.hostname(),
      uptime: os.uptime(),
      loadavg: os.loadavg(),
      totalmem: os.totalmem(),
      freemem: os.freemem(),
      cpus: os.cpus().length,
    },
  };

  // Check service health
  const services = {
    mongodb: await checkMongoDBHealth(),
    traefik: await checkTraefikHealth(),
    configManager: coreServices.config.initialized,
    routingManager: coreServices.routing.initialized,
  };

  // Always return 200 for Docker healthcheck
  res.status(200).json({
    status: "ok",
    service: "cloudlunacy-front",
    health,
    services,
  });
});

/**
 * Check MongoDB health
 *
 * GET /api/health/mongo
 */
exports.checkMongo = asyncHandler(async (req, res) => {
  logger.info("Checking MongoDB health");

  // Check MongoDB port
  const portActive = await coreServices.mongodb.checkMongoDBPort();

  // Check MongoDB configuration
  const configValid = await checkMongoDBConfig();

  res.status(200).json({
    success: true,
    portActive,
    configValid,
    message: portActive
      ? "MongoDB port is active"
      : "MongoDB port is not active",
  });
});

/**
 * Check Traefik health
 *
 * GET /api/health/traefik
 */
exports.checkTraefik = asyncHandler(async (req, res) => {
  logger.info("Checking Traefik health");

  // Check Traefik container status
  const containerStatus = await checkTraefikContainer();

  // Check if port 8081 (dashboard) is accessible
  const dashboardAccessible = await checkPort(8081);

  // Check if dynamic configuration is valid
  const configValid = await checkTraefikConfig();

  res.status(200).json({
    success: true,
    containerStatus,
    dashboardAccessible,
    configValid,
  });
});

/**
 * Repair system
 *
 * POST /api/health/repair
 */
exports.repair = asyncHandler(async (req, res) => {
  logger.info("Repairing system");

  // Repair core services
  const servicesRepaired = await coreServices.repair();

  // Restart Traefik
  const traefikRestarted = await restartTraefik();

  res.status(200).json({
    success: true,
    servicesRepaired,
    traefikRestarted,
    message: "System repair completed",
  });
});

// Helper functions

/**
 * Check MongoDB health
 */
async function checkMongoDBHealth() {
  try {
    // Check if MongoDB port is active
    const portActive = await coreServices.mongodb.checkMongoDBPort();

    return {
      portActive,
      status: portActive ? "active" : "inactive",
    };
  } catch (err) {
    logger.error(`Failed to check MongoDB health: ${err.message}`);
    return {
      portActive: false,
      status: "error",
      error: err.message,
    };
  }
}

/**
 * Check MongoDB configuration
 */
async function checkMongoDBConfig() {
  try {
    // Make sure config is initialized
    await coreServices.config.initialize();

    // Get main config
    const mainConfig = coreServices.config.configs.main;

    // Check if MongoDB catchall router exists
    const catchallExists = mainConfig?.tcp?.routers?.["mongodb-catchall"];

    // Check if MongoDB catchall service exists
    const serviceExists =
      mainConfig?.tcp?.services?.["mongodb-catchall-service"];

    return {
      valid: catchallExists && serviceExists,
      catchallExists: !!catchallExists,
      serviceExists: !!serviceExists,
    };
  } catch (err) {
    logger.error(`Failed to check MongoDB config: ${err.message}`);
    return {
      valid: false,
      error: err.message,
    };
  }
}

/**
 * Check Traefik health
 */
async function checkTraefikHealth() {
  try {
    // Check if Traefik container is running
    const containerStatus = await checkTraefikContainer();

    return {
      containerRunning: containerStatus.running,
      status: containerStatus.running ? "active" : "inactive",
      containerDetails: containerStatus,
    };
  } catch (err) {
    logger.error(`Failed to check Traefik health: ${err.message}`);
    return {
      containerRunning: false,
      status: "error",
      error: err.message,
    };
  }
}

/**
 * Check Traefik container status
 */
async function checkTraefikContainer() {
  try {
    const { stdout } = await execAsync(
      'docker ps -a --format "{{.Names}},{{.Status}},{{.Ports}}" --filter "name=traefik"'
    );

    if (!stdout.trim()) {
      return {
        running: false,
        error: "No Traefik container found",
      };
    }

    const [name, status, ports] = stdout.trim().split(",");

    return {
      running: status.includes("Up"),
      name,
      status,
      ports,
    };
  } catch (err) {
    logger.error(`Failed to check Traefik container: ${err.message}`);

    return {
      running: false,
      error: err.message,
    };
  }
}

/**
 * Check if Traefik configuration is valid
 */
async function checkTraefikConfig() {
  try {
    // Make sure config manager is initialized
    await coreServices.config.initialize();

    // Check if config has required sections
    const config = coreServices.config.configs.main;

    const httpValid =
      config &&
      config.http &&
      config.http.routers &&
      config.http.services &&
      config.http.middlewares;

    const tcpValid =
      config && config.tcp && config.tcp.routers && config.tcp.services;

    const mongoValid =
      tcpValid &&
      config.tcp.routers["mongodb-catchall"] &&
      config.tcp.services["mongodb-catchall-service"];

    return {
      valid: httpValid && tcpValid && mongoValid,
      details: {
        httpValid,
        tcpValid,
        mongoValid,
      },
    };
  } catch (err) {
    logger.error(`Failed to check Traefik config: ${err.message}`);

    return {
      valid: false,
      error: err.message,
    };
  }
}

/**
 * Check if a port is accessible locally
 */
async function checkPort(port) {
  try {
    const { stdout } = await execAsync(
      `curl -s -o /dev/null -w "%{http_code}" http://localhost:${port} || echo "failed"`
    );

    return stdout !== "failed" && stdout !== "";
  } catch (err) {
    return false;
  }
}

/**
 * Restart Traefik container
 */
async function restartTraefik() {
  try {
    logger.info("Restarting Traefik container");
    await execAsync("docker restart traefik");
    return true;
  } catch (err) {
    logger.error(`Failed to restart Traefik: ${err.message}`);
    return false;
  }
}

/**
 * Check MongoDB listener status
 *
 * GET /api/health/mongodb-listener
 */
exports.checkMongoDBListener = asyncHandler(async (req, res) => {
  logger.info("Checking MongoDB listener status");

  // Check if MongoDB port is active
  const portActive = await coreServices.mongodb.checkMongoDBPort();

  if (!portActive) {
    logger.warn("MongoDB listener is not active, attempting to fix");

    // Try to fix the issue
    const fixed = await coreServices.mongodb.ensureMongoDBEntrypoint();

    if (!fixed) {
      return res.status(500).json({
        success: false,
        status: "error",
        message: "MongoDB listener is not active and could not be fixed",
        details: {
          port: 27017,
          active: false,
          fixed: false,
        },
      });
    }

    return res.status(200).json({
      success: true,
      status: "fixed",
      message: "MongoDB listener was not active but has been fixed",
      details: {
        port: 27017,
        active: true,
        fixed: true,
      },
    });
  }

  return res.status(200).json({
    success: true,
    status: "ok",
    message: "MongoDB listener is active",
    details: {
      port: 27017,
      active: true,
    },
  });
});
