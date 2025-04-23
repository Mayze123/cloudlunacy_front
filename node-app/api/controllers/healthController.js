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
const {
  enhancedHAProxyService,
  enhancedCertificateService,
} = require("../../services/core");
const logger = require("../../utils/logger").getLogger("healthController");
const { asyncHandler } = require("../../utils/errorHandler");
const path = require("path");
const fs = require("fs").promises;

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

/**
 * Get system health status
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.getSystemHealth = async (req, res) => {
  try {
    const health = {
      status: "healthy",
      timestamp: new Date().toISOString(),
      services: {},
    };

    // Check HAProxy health if enhanced service is initialized
    try {
      if (enhancedHAProxyService.initialized) {
        // Force refresh the health status if requested
        const forceRefresh = req.query.refresh === "true";
        const haproxyHealth = await enhancedHAProxyService.getHealthStatus(
          forceRefresh
        );

        health.services.haproxy = {
          status: haproxyHealth.status,
          circuitState: haproxyHealth.circuitState,
          lastCheck: haproxyHealth.lastCheck?.timestamp,
          metrics: {
            routeCount: haproxyHealth.routeCount,
            connections: haproxyHealth.metrics?.connections,
          },
        };

        // Update overall health based on HAProxy status
        if (haproxyHealth.status === "UNHEALTHY") {
          health.status = "degraded";
        }
      } else {
        health.services.haproxy = {
          status: "not_initialized",
          message: "HAProxy service is not initialized",
        };
        health.status = "degraded";
      }
    } catch (err) {
      health.services.haproxy = {
        status: "error",
        message: `Failed to check HAProxy health: ${err.message}`,
      };
      health.status = "degraded";
    }

    // TODO: Add other services health checks here as needed

    res.json(health);
  } catch (err) {
    logger.error(`Error in getSystemHealth: ${err.message}`);
    res.status(500).json({
      status: "error",
      message: "Failed to retrieve system health status",
      error: err.message,
    });
  }
};

/**
 * Get detailed HAProxy health metrics
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.getHAProxyHealth = async (req, res) => {
  try {
    if (!enhancedHAProxyService.initialized) {
      return res.status(503).json({
        success: false,
        message: "HAProxy service is not initialized",
      });
    }

    // Get detailed metrics with optional refresh
    const forceRefresh = req.query.refresh === "true";
    const health = await enhancedHAProxyService.getHealthStatus(forceRefresh);

    res.json({
      success: true,
      health,
    });
  } catch (err) {
    logger.error(`Error in getHAProxyHealth: ${err.message}`);
    res.status(500).json({
      success: false,
      message: "Failed to retrieve HAProxy health",
      error: err.message,
    });
  }
};

/**
 * Get HAProxy stats and metrics
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.getHAProxyStats = async (req, res) => {
  try {
    if (!enhancedHAProxyService.initialized) {
      return res.status(503).json({
        success: false,
        message: "HAProxy service is not initialized",
      });
    }

    const stats = await enhancedHAProxyService.getStats();

    res.json({
      success: true,
      stats,
    });
  } catch (err) {
    logger.error(`Error in getHAProxyStats: ${err.message}`);
    res.status(500).json({
      success: false,
      message: "Failed to retrieve HAProxy stats",
      error: err.message,
    });
  }
};

/**
 * Attempt to recover HAProxy service
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.recoverHAProxyService = async (req, res) => {
  try {
    if (!enhancedHAProxyService.initialized) {
      return res.status(503).json({
        success: false,
        message: "HAProxy service is not initialized",
      });
    }

    // Check if administrator key is provided for this sensitive operation
    const adminKey = req.headers["x-admin-key"] || "";
    const configuredKey = process.env.ADMIN_KEY || "";

    if (!configuredKey || adminKey !== configuredKey) {
      logger.warn(`Unauthorized HAProxy recovery attempt from ${req.ip}`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized: Admin key required for this operation",
      });
    }

    // Attempt recovery
    logger.info(`Manual HAProxy recovery initiated by admin from ${req.ip}`);
    const result = await enhancedHAProxyService.recoverService();

    if (result.success) {
      res.json({
        success: true,
        message: result.message,
        action: result.action,
      });
    } else {
      res.status(500).json({
        success: false,
        message: result.message,
        error: result.error,
      });
    }
  } catch (err) {
    logger.error(`Error in recoverHAProxyService: ${err.message}`);
    res.status(500).json({
      success: false,
      message: "Failed to recover HAProxy service",
      error: err.message,
    });
  }
};

/**
 * Validate HAProxy configuration
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.validateHAProxyConfig = async (req, res) => {
  try {
    if (!enhancedHAProxyService.initialized) {
      return res.status(503).json({
        success: false,
        message: "HAProxy service is not initialized",
      });
    }

    const validationResult = await enhancedHAProxyService.validateConfig();

    res.json({
      success: true,
      valid: validationResult.valid,
      message: validationResult.message,
      error: validationResult.error,
    });
  } catch (err) {
    logger.error(`Error in validateHAProxyConfig: ${err.message}`);
    res.status(500).json({
      success: false,
      message: "Failed to validate HAProxy configuration",
      error: err.message,
    });
  }
};

/**
 * Get certificate status report
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.getCertificateReport = async (req, res) => {
  try {
    await enhancedCertificateService.initialize();

    const report = await enhancedCertificateService.getCertificateReport();

    res.status(200).json({
      success: true,
      report,
    });
  } catch (err) {
    logger.error(`Error getting certificate report: ${err.message}`);
    res.status(500).json({
      success: false,
      error: "Failed to retrieve certificate report",
    });
  }
};

/**
 * Get certificate metrics
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.getCertificateMetrics = async (req, res) => {
  try {
    await enhancedCertificateService.initialize();

    const metrics = await enhancedCertificateService.getMetrics();

    res.status(200).json({
      success: true,
      metrics,
    });
  } catch (err) {
    logger.error(`Error getting certificate metrics: ${err.message}`);
    res.status(500).json({
      success: false,
      error: "Failed to retrieve certificate metrics",
    });
  }
};

/**
 * Validate a certificate
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.validateCertificate = async (req, res) => {
  try {
    await enhancedCertificateService.initialize();

    const { certPath } = req.body;

    if (!certPath) {
      return res.status(400).json({
        success: false,
        error: "Certificate path is required",
      });
    }

    const certManager = enhancedCertificateService.certManager;
    const result = await certManager.validateCertificate(certPath);

    res.status(200).json({
      success: true,
      valid: result.valid,
      certificate: result.certificate,
      error: result.error,
    });
  } catch (err) {
    logger.error(`Error validating certificate: ${err.message}`);
    res.status(500).json({
      success: false,
      error: "Failed to validate certificate",
    });
  }
};

/**
 * Request certificate renewal
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.renewCertificate = async (req, res) => {
  try {
    await enhancedCertificateService.initialize();

    const { certPath, agentId, domain, force } = req.body;

    if (!certPath && !agentId && !domain) {
      return res.status(400).json({
        success: false,
        error: "Certificate path, agent ID, or domain is required",
      });
    }

    let result;

    if (agentId) {
      result = await enhancedCertificateService.renewAgentCertificate(agentId);
    } else if (domain) {
      result = await enhancedCertificateService.generateLetsEncryptCertificate(
        domain
      );
    } else {
      // Get certificate info
      const certManager = enhancedCertificateService.certManager;
      const certInfo = await certManager.analyzeCertificate(certPath);

      if (!certInfo) {
        return res.status(400).json({
          success: false,
          error: "Invalid certificate or certificate not found",
        });
      }

      // Check if certificate needs renewal
      if (!force && !certInfo.isExpiring && !certInfo.isExpired) {
        return res.status(200).json({
          success: true,
          renewed: false,
          message: "Certificate does not need renewal",
          certificate: certInfo,
        });
      }

      // Renew based on type
      if (certInfo.agent) {
        result = await enhancedCertificateService.renewAgentCertificate(
          certInfo.agent
        );
      } else if (certPath.includes("letsencrypt")) {
        result = await enhancedCertificateService.renewLetsEncryptCertificate(
          certInfo
        );
      } else {
        return res.status(400).json({
          success: false,
          error: "Unknown certificate type for renewal",
        });
      }
    }

    res.status(200).json({
      success: true,
      result,
    });
  } catch (err) {
    logger.error(`Error renewing certificate: ${err.message}`);
    res.status(500).json({
      success: false,
      error: `Failed to renew certificate: ${err.message}`,
    });
  }
};

/**
 * Generate Let's Encrypt certificate
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.generateLetsEncryptCertificate = async (req, res) => {
  try {
    await enhancedCertificateService.initialize();

    const { domain, email } = req.body;

    if (!domain) {
      return res.status(400).json({
        success: false,
        error: "Domain is required",
      });
    }

    const result =
      await enhancedCertificateService.generateLetsEncryptCertificate(domain, {
        email,
      });

    res.status(200).json({
      success: true,
      result,
    });
  } catch (err) {
    logger.error(`Error generating Let's Encrypt certificate: ${err.message}`);
    res.status(500).json({
      success: false,
      error: `Failed to generate Let's Encrypt certificate: ${err.message}`,
    });
  }
};

/**
 * Get basic health status
 * Simple health check for load balancers and container orchestration
 *
 * GET /api/health
 */
exports.getBasicHealth = asyncHandler(async (req, res) => {
  logger.debug("Basic health check requested");

  // Simple health check with minimal processing for load balancers
  const health = {
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "cloudlunacy-front",
  };

  res.status(200).json(health);
});

/**
 * Get comprehensive system health dashboard
 * Aggregates health information from all components
 *
 * GET /api/health/dashboard
 */
exports.getHealthDashboard = asyncHandler(async (req, res) => {
  logger.info("Health dashboard requested");
  const startTime = Date.now();

  try {
    // Collect system health metrics
    const dashboard = {
      status: "healthy", // Will be updated based on component status
      timestamp: new Date().toISOString(),
      systemInfo: {
        platform: os.platform(),
        arch: os.arch(),
        hostname: os.hostname(),
        uptime: os.uptime(),
        cpus: os.cpus().length,
        memory: {
          total: os.totalmem(),
          free: os.freemem(),
          usedPercent: (
            ((os.totalmem() - os.freemem()) / os.totalmem()) *
            100
          ).toFixed(1),
        },
        load: os.loadavg(),
      },
      application: {
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        version: process.env.APP_VERSION || "1.0.0",
      },
      components: {},
      alerts: [],
      recommendations: [],
    };

    // Get HAProxy health (with metrics if available)
    try {
      if (
        coreServices.enhancedHAProxyService &&
        coreServices.enhancedHAProxyService.initialized
      ) {
        const forceRefresh = req.query.refresh === "true";
        const haproxyHealth =
          await coreServices.enhancedHAProxyService.getHealthStatus(
            forceRefresh
          );

        dashboard.components.haproxy = {
          status: haproxyHealth.status,
          lastCheck: haproxyHealth.lastCheck?.timestamp,
          circuitBreakerState: haproxyHealth.circuitState || "UNKNOWN",
          containerRunning: haproxyHealth.containerRunning || false,
          configValid: haproxyHealth.configValid || false,
          metrics: haproxyHealth.metrics || null,
        };

        // Get detailed metrics if available
        if (coreServices.enhancedHAProxyService.metricsCollector) {
          const metrics =
            coreServices.enhancedHAProxyService.metricsCollector.getCurrentMetrics();
          if (metrics && metrics.haproxy && metrics.haproxy.summary) {
            dashboard.components.haproxy.detailedMetrics =
              metrics.haproxy.summary;

            // Get anomalies
            const anomalies =
              coreServices.enhancedHAProxyService.metricsCollector.getAnomalies(
                5
              );
            if (anomalies && anomalies.length > 0) {
              dashboard.components.haproxy.anomalies = anomalies;

              // Add high severity anomalies to alerts
              anomalies.forEach((anomaly) => {
                if (anomaly.severity === "high") {
                  dashboard.alerts.push({
                    component: "haproxy",
                    severity: "high",
                    message: anomaly.message,
                    timestamp: anomaly.timestamp,
                  });
                }
              });
            }

            // Get trends
            const trends =
              coreServices.enhancedHAProxyService.metricsCollector.calculateTrends();
            if (trends && trends.status !== "insufficient_data") {
              dashboard.components.haproxy.trends = trends;
            }
          }
        }

        // Update overall status based on HAProxy status
        if (haproxyHealth.status === "UNHEALTHY") {
          dashboard.status = "critical";
          dashboard.alerts.push({
            component: "haproxy",
            severity: "critical",
            message: "HAProxy is unhealthy",
          });

          // Add recommendations for HAProxy issues
          dashboard.recommendations.push({
            component: "haproxy",
            action: "Run manual recovery",
            endpoint: "/api/health/haproxy/recover",
            description: "Attempt to automatically recover HAProxy service",
          });
        } else if (haproxyHealth.status === "DEGRADED") {
          if (dashboard.status === "healthy") {
            dashboard.status = "degraded";
          }
          dashboard.alerts.push({
            component: "haproxy",
            severity: "warning",
            message: "HAProxy is in a degraded state",
          });
        }
      } else {
        dashboard.components.haproxy = {
          status: "unavailable",
          message: "HAProxy service is not initialized",
        };
        dashboard.status = "degraded";
      }
    } catch (err) {
      logger.error(`Failed to get HAProxy health: ${err.message}`);
      dashboard.components.haproxy = {
        status: "error",
        message: `Failed to get HAProxy health: ${err.message}`,
      };
      dashboard.status = "degraded";
    }

    // Get Certificate Service health
    try {
      if (
        coreServices.certificateService &&
        coreServices.certificateService.initialized
      ) {
        // Get certificate report
        const certReport =
          await coreServices.certificateService.getCertificateReport();

        dashboard.components.certificates = {
          status: certReport.status || "unknown",
          total: certReport.total || 0,
          valid: certReport.valid || 0,
          expiring: certReport.expiring || 0,
          expired: certReport.expired || 0,
          details: certReport.details || null,
        };

        // Check for certificate issues
        if (certReport.expired > 0) {
          if (dashboard.status === "healthy") {
            dashboard.status = "critical";
          }
          dashboard.alerts.push({
            component: "certificates",
            severity: "critical",
            message: `${certReport.expired} certificate(s) are expired`,
          });

          // Add recommendations for expired certificates
          dashboard.recommendations.push({
            component: "certificates",
            action: "Renew expired certificates",
            endpoint: "/api/health/certificates/renew",
            description:
              "Renew expired certificates to prevent service disruption",
          });
        } else if (certReport.expiring > 0) {
          if (dashboard.status === "healthy") {
            dashboard.status = "warning";
          }
          dashboard.alerts.push({
            component: "certificates",
            severity: "warning",
            message: `${certReport.expiring} certificate(s) are about to expire`,
          });
        }
      } else {
        dashboard.components.certificates = {
          status: "unavailable",
          message: "Certificate service is not initialized",
        };
      }
    } catch (err) {
      logger.error(`Failed to get certificate health: ${err.message}`);
      dashboard.components.certificates = {
        status: "error",
        message: `Failed to get certificate health: ${err.message}`,
      };
    }

    // Get MongoDB status
    try {
      const mongoDBHealth = await checkMongoDBHealth();
      const mongoDBConfig = await checkMongoDBConfig();

      dashboard.components.mongodb = {
        status: mongoDBHealth.status,
        portActive: mongoDBHealth.portActive,
        configValid: mongoDBConfig.valid,
      };

      if (!mongoDBHealth.portActive) {
        if (dashboard.status === "healthy") {
          dashboard.status = "degraded";
        }
        dashboard.alerts.push({
          component: "mongodb",
          severity: "warning",
          message: "MongoDB port is not active",
        });

        dashboard.recommendations.push({
          component: "mongodb",
          action: "Fix MongoDB listener",
          endpoint: "/api/health/mongodb-listener",
          description: "Attempt to fix MongoDB port listener",
        });
      }
    } catch (err) {
      logger.error(`Failed to get MongoDB health: ${err.message}`);
      dashboard.components.mongodb = {
        status: "error",
        message: `Failed to get MongoDB health: ${err.message}`,
      };
    }

    // Get Routing Service health
    if (coreServices.routingService) {
      dashboard.components.routing = {
        status: coreServices.routingService.initialized
          ? "healthy"
          : "not_initialized",
      };
    }

    // Get Config Service health
    if (coreServices.configService) {
      dashboard.components.config = {
        status: coreServices.configService.initialized
          ? "healthy"
          : "not_initialized",
      };
    }

    // Calculate response time
    const responseTime = Date.now() - startTime;
    dashboard.responseTime = responseTime;

    res.status(200).json({
      success: true,
      dashboard,
    });
  } catch (err) {
    logger.error(`Error generating health dashboard: ${err.message}`, {
      error: err.message,
      stack: err.stack,
    });

    res.status(500).json({
      success: false,
      message: "Failed to generate health dashboard",
      error: err.message,
    });
  }
});

/**
 * Get detailed Traefik health metrics
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.getTraefikHealth = async (req, res) => {
  try {
    const traefikService = coreServices.traefikService;

    if (!traefikService || !traefikService.initialized) {
      return res.status(503).json({
        success: false,
        message: "Traefik service is not initialized",
      });
    }

    // Get detailed metrics with optional refresh
    const forceRefresh = req.query.refresh === "true";
    let health;

    if (forceRefresh) {
      health = await traefikService.performHealthCheck();
    } else {
      health = traefikService.getHealthStatus();
    }

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      status: health.status,
      details: health.details,
    });
  } catch (err) {
    logger.error(`Error in getTraefikHealth: ${err.message}`);
    res.status(500).json({
      success: false,
      message: "Failed to retrieve Traefik health",
      error: err.message,
    });
  }
};

/**
 * Get Traefik stats and metrics
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.getTraefikStats = async (req, res) => {
  try {
    const traefikService = coreServices.traefikService;

    if (!traefikService || !traefikService.initialized) {
      return res.status(503).json({
        success: false,
        message: "Traefik service is not initialized",
      });
    }

    const stats = await traefikService.getStats();

    res.json({
      success: true,
      stats,
    });
  } catch (err) {
    logger.error(`Error in getTraefikStats: ${err.message}`);
    res.status(500).json({
      success: false,
      message: "Failed to retrieve Traefik stats",
      error: err.message,
    });
  }
};

/**
 * Attempt to recover Traefik service
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.recoverTraefikService = async (req, res) => {
  try {
    const traefikService = coreServices.traefikService;

    if (!traefikService || !traefikService.initialized) {
      return res.status(503).json({
        success: false,
        message: "Traefik service is not initialized",
      });
    }

    // Check if administrator key is provided for this sensitive operation
    const adminKey = req.headers["x-admin-key"] || "";
    const configuredKey = process.env.ADMIN_KEY || "";

    if (!configuredKey || adminKey !== configuredKey) {
      logger.warn(`Unauthorized Traefik recovery attempt from ${req.ip}`);
      return res.status(401).json({
        success: false,
        message: "Unauthorized: Admin key required for this operation",
      });
    }

    // Attempt recovery
    logger.info(`Manual Traefik recovery initiated by admin from ${req.ip}`);
    const result = await traefikService.recoverService();

    if (result.success) {
      res.json({
        success: true,
        message: result.message,
        action: result.action,
      });
    } else {
      res.status(500).json({
        success: false,
        message: result.message,
        error: result.error,
      });
    }
  } catch (err) {
    logger.error(`Error in recoverTraefikService: ${err.message}`);
    res.status(500).json({
      success: false,
      message: "Failed to recover Traefik service",
      error: err.message,
    });
  }
};

/**
 * Validate Traefik configuration
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.validateTraefikConfig = async (req, res) => {
  try {
    const traefikService = coreServices.traefikService;

    if (!traefikService || !traefikService.initialized) {
      return res.status(503).json({
        success: false,
        message: "Traefik service is not initialized",
      });
    }

    const validationResult = await traefikService.validateConfig();

    res.json({
      success: validationResult.success,
      message: validationResult.message,
      details: validationResult.details,
    });
  } catch (err) {
    logger.error(`Error in validateTraefikConfig: ${err.message}`);
    res.status(500).json({
      success: false,
      message: "Failed to validate Traefik configuration",
      error: err.message,
    });
  }
};
