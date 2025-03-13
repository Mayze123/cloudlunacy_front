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
exports.checkMongo = async (req, res, next) => {
  try {
    logger.info("Checking MongoDB health");

    // Check MongoDB port
    const portOk = await mongodbManager.checkMongoDBPort();

    // If port is not OK, try to fix it
    if (!portOk) {
      logger.warn("MongoDB port not properly exposed, attempting to fix");
      await mongodbManager.ensureMongoDBPort();
    }

    // Get MongoDB registrations
    const registrations = await mongodbManager.listRegisteredAgents();

    // Test connectivity to the first few agents
    const connectivityTests = [];
    const maxTests = Math.min(3, registrations.registrations?.length || 0);

    for (let i = 0; i < maxTests; i++) {
      const reg = registrations.registrations[i];
      const test = await mongodbManager.testConnection(
        reg.agentId,
        reg.targetAddress?.split(":")[0]
      );
      connectivityTests.push({
        agentId: reg.agentId,
        domain: reg.mongoUrl,
        targetAddress: reg.targetAddress,
        result: test,
      });
    }

    res.status(200).json({
      success: true,
      portOk,
      registrationsCount: registrations.registrations?.length || 0,
      connectivityTests,
    });
  } catch (err) {
    logger.error(`MongoDB health check failed: ${err.message}`, {
      error: err.message,
      stack: err.stack,
    });

    next(err);
  }
};

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
