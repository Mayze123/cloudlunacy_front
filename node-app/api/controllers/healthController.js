// api/controllers/healthController.js
/**
 * Health Controller
 *
 * Handles health checks and monitoring.
 */

const os = require("os");
const mongodbManager = require("../../services/mongodbManager");
const configManager = require("../../services/configManager");
const routingManager = require("../../services/routingManager");
const logger = require("../../utils/logger").getLogger("healthController");
const { exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);
const { asyncHandler } = require("express-async-handler");
const coreServices = require("../../services/core");

/**
 * Get system health
 *
 * GET /api/health
 */
exports.getHealth = async (req, res, next) => {
  try {
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
      configManager: configManager.initialized,
      routingManager: routingManager.initialized,
    };

    // Always return 200 for Docker healthcheck
    res.status(200).json({
      status: "ok",
      service: "cloudlunacy-front",
      health,
      services,
    });
  } catch (err) {
    logger.error(`Health check failed: ${err.message}`, {
      error: err.message,
      stack: err.stack,
    });

    // Still return 200 for Docker healthcheck
    res.status(200).json({
      status: "warning",
      service: "cloudlunacy-front",
      error: err.message,
    });
  }
};

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
exports.checkTraefik = async (req, res, next) => {
  try {
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
  } catch (err) {
    logger.error(`Traefik health check failed: ${err.message}`, {
      error: err.message,
      stack: err.stack,
    });

    next(err);
  }
};

/**
 * Repair system
 *
 * POST /api/health/repair
 */
exports.repair = async (req, res, next) => {
  try {
    logger.info("Repairing system");

    // Repair configurations
    await configManager.repairAllConfigurations();

    // Ensure MongoDB port is properly configured
    const mongodbPortFixed = await mongodbManager.ensureMongoDBPort();

    // Ensure MongoDB entrypoint is properly configured
    const mongodbEntrypointFixed =
      await mongodbManager.ensureMongoDBEntrypoint();

    // Restart Traefik to apply changes
    const traefikRestarted = await mongodbManager.restartTraefik();

    res.status(200).json({
      success: true,
      message: "System repaired successfully",
      details: {
        configRepaired: true,
        mongodbPortFixed,
        mongodbEntrypointFixed,
        traefikRestarted,
      },
    });
  } catch (err) {
    logger.error(`System repair failed: ${err.message}`, {
      error: err.message,
      stack: err.stack,
    });

    next(err);
  }
};

/**
 * Check MongoDB health
 */
async function checkMongoDBHealth() {
  try {
    // Check MongoDB port
    const portOk = await mongodbManager.checkMongoDBPort();

    return {
      status: portOk ? "ok" : "error",
      portExposed: portOk,
    };
  } catch (err) {
    logger.error(`MongoDB health check failed: ${err.message}`);

    return {
      status: "error",
      error: err.message,
    };
  }
}

/**
 * Check Traefik health
 */
async function checkTraefikHealth() {
  try {
    // Check Traefik container status
    const containerStatus = await checkTraefikContainer();

    return {
      status: containerStatus.running ? "ok" : "error",
      containerInfo: containerStatus,
    };
  } catch (err) {
    logger.error(`Traefik health check failed: ${err.message}`);

    return {
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
    await configManager.initialize();

    // Check if config has required sections
    const config = configManager.configs.main;

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
