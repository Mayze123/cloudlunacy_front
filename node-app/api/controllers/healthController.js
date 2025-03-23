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
const { asyncHandler } = require("../../utils/errorHandler");

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

  // Initialize services status
  const status = {
    agentService: coreServices.agentService ? "ok" : "not-available",
    certificateService: coreServices.certificateService
      ? "ok"
      : "not-available",
    configService: coreServices.configService.initialized,
    routingService: coreServices.routingService.initialized,
    haproxyService: coreServices.haproxyService ? "ok" : "not-available",
    letsencryptService: coreServices.letsencryptService
      ? "ok"
      : "not-available",
    // ... other services
  };

  // Always return 200 for Docker healthcheck
  res.status(200).json({
    status: "ok",
    service: "cloudlunacy-front",
    health,
    services: status,
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
  const portActive = await coreServices.mongodbService.checkMongoDBPort();

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
 * Check HAProxy health
 *
 * GET /api/health/haproxy
 */
exports.checkHAProxy = asyncHandler(async (req, res) => {
  logger.info("Checking HAProxy health");

  // Check HAProxy container status
  const containerStatus = await checkHAProxyContainer();

  // Check if stats page (port 8081) is accessible
  const statsAccessible = await checkPort(8081);

  // Check if configuration is valid
  const configValid = await checkHAProxyConfig();

  res.status(200).json({
    success: true,
    containerStatus,
    statsAccessible,
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

  // Restart HAProxy
  const haproxyRestarted = await restartHAProxy();

  res.status(200).json({
    success: true,
    servicesRepaired,
    haproxyRestarted,
    message: "System repair completed",
  });
});

/**
 * Check MongoDB connections
 *
 * @param {object} req - The request object
 * @param {object} res - The response object
 * @returns {Promise<void>}
 */
exports.checkMongoDBConnections = async (req, res) => {
  try {
    await coreServices.configService.initialize();

    const haproxyConfig = await coreServices.configService.getConfig("haproxy");
    const issues = [];

    // Check MongoDB backend
    if (
      haproxyConfig.backends &&
      haproxyConfig.backends["mongodb-backend-dyn"]
    ) {
      const backend = haproxyConfig.backends["mongodb-backend-dyn"];

      // Check if backend has servers
      if (!backend.servers || backend.servers.length === 0) {
        issues.push({
          type: "missing_servers",
          backend: "mongodb-backend-dyn",
        });
      } else {
        // Check each server for issues
        for (const server of backend.servers) {
          // Extract agent ID from server name
          const agentId = server.name.replace("mongodb-", "");

          // Check if SNI is configured correctly
          if (!server.sni || !server.sni.includes(agentId)) {
            issues.push({
              type: "invalid_sni",
              agentId,
              serverName: server.name,
            });
          }

          // Check if server has an address
          if (!server.address) {
            issues.push({
              type: "missing_address",
              agentId,
              serverName: server.name,
            });
          }
        }
      }
    } else {
      issues.push({
        type: "missing_backend",
        backend: "mongodb-backend-dyn",
      });
    }

    // Return the results
    res.status(200).json({
      success: true,
      mongodbConnections: {
        issues: issues,
        healthy: issues.length === 0,
      },
    });
  } catch (err) {
    logger.error(`Failed to check MongoDB connections: ${err.message}`, {
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json({
      success: false,
      message: "Failed to check MongoDB connections",
      error: err.message,
    });
  }
};

/**
 * Check HAProxy connections
 *
 * @param {object} req - The request object
 * @param {object} res - The response object
 * @returns {Promise<void>}
 */
exports.checkHaproxy = async (req, res) => {
  try {
    await coreServices.configService.initialize();

    const haproxyConfig = await coreServices.configService.getConfig("haproxy");
    // ... existing code ...
  } catch (err) {
    // ... existing code ...
  }
};

// Helper functions

/**
 * Check MongoDB health
 */
async function checkMongoDBHealth() {
  try {
    // Check if MongoDB port is active
    const portActive = await coreServices.mongodbService.checkMongoDBPort();

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
    await coreServices.configService.initialize();

    // Get HAProxy config
    const haproxyConfig = await coreServices.configService.getConfig("haproxy");

    // Check if MongoDB backend exists
    const backendExists = haproxyConfig?.backends?.["mongodb-backend-dyn"];

    return {
      valid: !!backendExists,
      backendExists: !!backendExists,
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
 * Check HAProxy health
 */
async function checkHAProxyHealth() {
  try {
    // Check if HAProxy container is running
    const containerStatus = await checkHAProxyContainer();

    return {
      containerRunning: containerStatus.running,
      status: containerStatus.running ? "active" : "inactive",
      containerDetails: containerStatus,
    };
  } catch (err) {
    logger.error(`Failed to check HAProxy health: ${err.message}`);
    return {
      containerRunning: false,
      status: "error",
      error: err.message,
    };
  }
}

/**
 * Check HAProxy container status
 */
async function checkHAProxyContainer() {
  try {
    const { stdout } = await execAsync(
      'docker ps -a --format "{{.Names}},{{.Status}},{{.Ports}}" --filter "name=haproxy"'
    );

    if (!stdout.trim()) {
      return {
        running: false,
        error: "No HAProxy container found",
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
    logger.error(`Failed to check HAProxy container: ${err.message}`);

    return {
      running: false,
      error: err.message,
    };
  }
}

/**
 * Check if HAProxy configuration is valid
 */
async function checkHAProxyConfig() {
  try {
    // Make sure config manager is initialized
    await coreServices.configService.initialize();

    // Check if config has required sections
    const haproxyConfig = await coreServices.configService.getConfig("haproxy");

    const frontendsValid =
      haproxyConfig &&
      haproxyConfig.frontends &&
      haproxyConfig.frontends["https-in"] &&
      haproxyConfig.frontends["mongodb-in"];

    const backendsValid =
      haproxyConfig &&
      haproxyConfig.backends &&
      haproxyConfig.backends["mongodb-backend-dyn"] &&
      haproxyConfig.backends["node-app-backend"];

    // Also check HAProxy configuration syntax using docker exec
    let syntaxValid = false;
    try {
      await execAsync(
        "docker exec haproxy haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg"
      );
      syntaxValid = true;
    } catch (checkErr) {
      logger.warn(`HAProxy config syntax check failed: ${checkErr.message}`);
      syntaxValid = false;
    }

    return {
      valid: frontendsValid && backendsValid && syntaxValid,
      details: {
        frontendsValid,
        backendsValid,
        syntaxValid,
      },
    };
  } catch (err) {
    logger.error(`Failed to check HAProxy config: ${err.message}`);

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
 * Restart HAProxy container
 */
async function restartHAProxy() {
  try {
    logger.info("Restarting HAProxy container");
    await execAsync("docker restart haproxy");
    return true;
  } catch (err) {
    logger.error(`Failed to restart HAProxy: ${err.message}`);
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
  const portActive = await coreServices.mongodbService.checkMongoDBPort();

  if (!portActive) {
    logger.warn("MongoDB listener is not active, attempting to fix");

    // Try to fix the issue by ensuring MongoDB port
    const fixed = await coreServices.mongodbService.ensureMongoDBPort();

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
