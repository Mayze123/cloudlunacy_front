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
const { enhancedCertificateService } = require("../../services/core");
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
    traefikService: coreServices.traefikService ? "ok" : "not-available",
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
 * Check Traefik health
 *
 * GET /api/health/traefik
 */
exports.checkTraefik = asyncHandler(async (req, res) => {
  logger.info("Checking Traefik health");

  // Check Traefik container status
  const containerStatus = await checkTraefikContainer();

  // Check if dashboard (port 8081) is accessible
  const dashboardAccessible = await checkPort(8081);

  // Check if configuration is valid
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

    const traefikConfig = await coreServices.configService.getConfig("traefik");
    const issues = [];

    // Check MongoDB routers and services in Traefik configuration
    if (
      traefikConfig.http &&
      traefikConfig.http.services &&
      traefikConfig.http.services["mongodb-service"]
    ) {
      const service = traefikConfig.http.services["mongodb-service"];

      // Check if service has servers
      if (
        !service.loadBalancer ||
        !service.loadBalancer.servers ||
        service.loadBalancer.servers.length === 0
      ) {
        issues.push({
          type: "missing_servers",
          service: "mongodb-service",
        });
      } else {
        // Check each server for issues
        for (const server of service.loadBalancer.servers) {
          // Extract agent ID from server URL
          const urlMatch = server.url.match(/mongodb-([^.]+)\./);
          const agentId = urlMatch ? urlMatch[1] : null;

          // Check if server has a URL
          if (!server.url) {
            issues.push({
              type: "missing_url",
              agentId,
              serverUrl: server.url,
            });
          }
        }
      }
    } else {
      issues.push({
        type: "missing_service",
        service: "mongodb-service",
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

    // Get Traefik config
    const traefikConfig = await coreServices.configService.getConfig("traefik");

    // Check if MongoDB service exists
    const serviceExists =
      traefikConfig?.http?.services?.["mongodb-service"] !== undefined;

    return {
      valid: !!serviceExists,
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
    await coreServices.configService.initialize();

    // Check if config has required sections
    const traefikConfig = await coreServices.configService.getConfig("traefik");

    const routersValid =
      traefikConfig &&
      traefikConfig.http &&
      traefikConfig.http.routers &&
      Object.keys(traefikConfig.http.routers).length > 0;

    const servicesValid =
      traefikConfig &&
      traefikConfig.http &&
      traefikConfig.http.services &&
      Object.keys(traefikConfig.http.services).length > 0;

    // Also check Traefik configuration syntax using docker exec
    let syntaxValid = false;
    try {
      await execAsync("docker exec traefik traefik validate --check-config");
      syntaxValid = true;
    } catch (checkErr) {
      logger.warn(`Traefik config syntax check failed: ${checkErr.message}`);
      syntaxValid = false;
    }

    return {
      valid: routersValid && servicesValid && syntaxValid,
      details: {
        routersValid,
        servicesValid,
        syntaxValid,
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

    // Check Traefik health if enhanced service is initialized
    try {
      if (coreServices.traefikService.initialized) {
        // Force refresh the health status if requested
        const forceRefresh = req.query.refresh === "true";
        const traefikHealth = await coreServices.traefikService.getHealthStatus(
          forceRefresh
        );

        health.services.traefik = {
          status: traefikHealth.status,
          circuitState: traefikHealth.circuitState,
          lastCheck: traefikHealth.lastCheck?.timestamp,
          metrics: {
            routeCount: traefikHealth.routeCount,
            connections: traefikHealth.metrics?.connections,
          },
        };

        // Update overall health based on Traefik status
        if (traefikHealth.status === "UNHEALTHY") {
          health.status = "degraded";
        }
      } else {
        health.services.traefik = {
          status: "not_initialized",
          message: "Traefik service is not initialized",
        };
        health.status = "degraded";
      }
    } catch (err) {
      health.services.traefik = {
        status: "error",
        message: `Failed to check Traefik health: ${err.message}`,
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
 * Get detailed Traefik health metrics
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.getTraefikHealth = async (req, res) => {
  try {
    if (!coreServices.traefikService.initialized) {
      return res.status(503).json({
        success: false,
        message: "Traefik service is not initialized",
      });
    }

    // Get detailed metrics with optional refresh
    const forceRefresh = req.query.refresh === "true";
    const health = await coreServices.traefikService.getHealthStatus(
      forceRefresh
    );

    res.json({
      success: true,
      health,
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
    if (!coreServices.traefikService.initialized) {
      return res.status(503).json({
        success: false,
        message: "Traefik service is not initialized",
      });
    }

    const stats = await coreServices.traefikService.getStats();

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
    if (!coreServices.traefikService.initialized) {
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
    const result = await coreServices.traefikService.recoverService();

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
    if (!coreServices.traefikService.initialized) {
      return res.status(503).json({
        success: false,
        message: "Traefik service is not initialized",
      });
    }

    const validationResult = await coreServices.traefikService.validateConfig();

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

    // Get Traefik health (with metrics if available)
    try {
      if (
        coreServices.traefikService &&
        coreServices.traefikService.initialized
      ) {
        const forceRefresh = req.query.refresh === "true";
        const traefikHealth = await coreServices.traefikService.getHealthStatus(
          forceRefresh
        );

        dashboard.components.traefik = {
          status: traefikHealth.status,
          lastCheck: traefikHealth.lastCheck?.timestamp,
          circuitBreakerState: traefikHealth.circuitState || "UNKNOWN",
          containerRunning: traefikHealth.containerRunning || false,
          configValid: traefikHealth.configValid || false,
          metrics: traefikHealth.metrics || null,
        };

        // Get detailed metrics if available
        if (coreServices.traefikService.metricsCollector) {
          const metrics =
            coreServices.traefikService.metricsCollector.getCurrentMetrics();
          if (metrics && metrics.traefik && metrics.traefik.summary) {
            dashboard.components.traefik.detailedMetrics =
              metrics.traefik.summary;

            // Get anomalies
            const anomalies =
              coreServices.traefikService.metricsCollector.getAnomalies(5);
            if (anomalies && anomalies.length > 0) {
              dashboard.components.traefik.anomalies = anomalies;

              // Add high severity anomalies to alerts
              anomalies.forEach((anomaly) => {
                if (anomaly.severity === "high") {
                  dashboard.alerts.push({
                    component: "traefik",
                    severity: "high",
                    message: anomaly.message,
                    timestamp: anomaly.timestamp,
                  });
                }
              });
            }

            // Get trends
            const trends =
              coreServices.traefikService.metricsCollector.calculateTrends();
            if (trends && trends.status !== "insufficient_data") {
              dashboard.components.traefik.trends = trends;
            }
          }
        }

        // Update overall status based on Traefik status
        if (traefikHealth.status === "UNHEALTHY") {
          dashboard.status = "critical";
          dashboard.alerts.push({
            component: "traefik",
            severity: "critical",
            message: "Traefik is unhealthy",
          });

          // Add recommendations for Traefik issues
          dashboard.recommendations.push({
            component: "traefik",
            action: "Run manual recovery",
            endpoint: "/api/health/traefik/recover",
            description: "Attempt to automatically recover Traefik service",
          });
        } else if (traefikHealth.status === "DEGRADED") {
          if (dashboard.status === "healthy") {
            dashboard.status = "degraded";
          }
          dashboard.alerts.push({
            component: "traefik",
            severity: "warning",
            message: "Traefik is in a degraded state",
          });
        }
      } else {
        dashboard.components.traefik = {
          status: "unavailable",
          message: "Traefik service is not initialized",
        };
        dashboard.status = "degraded";
      }
    } catch (err) {
      logger.error(`Failed to get Traefik health: ${err.message}`);
      dashboard.components.traefik = {
        status: "error",
        message: `Failed to get Traefik health: ${err.message}`,
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
