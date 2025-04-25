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
    consulService: coreServices.consulService ? "ok" : "not-available",
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
 * Check Consul health
 *
 * GET /api/health/consul
 */
exports.checkConsul = asyncHandler(async (req, res) => {
  logger.info("Checking Consul health");

  // Check Consul container status
  const containerStatus = await checkConsulContainer();

  // Check if API (port 8500) is accessible
  const apiAccessible = await checkPort(8500);

  // Check if configuration is valid
  const configValid = await checkConsulConfig();

  res.status(200).json({
    success: true,
    containerStatus,
    apiAccessible,
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

  // Check consul service
  let consulRepaired = false;
  if (coreServices.consulService && coreServices.consulService.isInitialized) {
    try {
      // Try to rebuild the key structure in Consul
      await coreServices.consulService.initializeKeyStructure();
      consulRepaired = true;
    } catch (err) {
      logger.error(`Failed to repair Consul: ${err.message}`);
    }
  }

  // Restart Consul
  const consulRestarted = await restartConsul();

  res.status(200).json({
    success: true,
    servicesRepaired,
    consulRepaired,
    consulRestarted,
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
    // Check if Consul service is available
    if (
      !coreServices.consulService ||
      !coreServices.consulService.isInitialized
    ) {
      return res.status(500).json({
        success: false,
        message: "Consul service is not available",
      });
    }

    // Get TCP routers and services from Consul
    const tcpRouters = await coreServices.consulService.get("tcp/routers");
    const tcpServices = await coreServices.consulService.get("tcp/services");
    const issues = [];

    // Check MongoDB routers and services in configuration
    if (!tcpRouters || Object.keys(tcpRouters).length === 0) {
      issues.push({
        type: "missing_routers",
        message: "No TCP routers configured in Consul",
      });
    } else {
      // Check each router for its corresponding service
      for (const [name, router] of Object.entries(tcpRouters)) {
        const serviceName = router.service;

        if (!serviceName) {
          issues.push({
            type: "missing_service_reference",
            router: name,
          });
          continue;
        }

        // Check if the service exists
        if (!tcpServices || !tcpServices[serviceName]) {
          issues.push({
            type: "missing_service",
            router: name,
            service: serviceName,
          });
          continue;
        }

        // Check if service has servers
        const service = tcpServices[serviceName];
        if (
          !service.loadBalancer ||
          !service.loadBalancer.servers ||
          service.loadBalancer.servers.length === 0
        ) {
          issues.push({
            type: "missing_servers",
            router: name,
            service: serviceName,
          });
        }
      }
    }

    // Return the results
    res.status(200).json({
      success: true,
      mongodbConnections: {
        issues: issues,
        healthy: issues.length === 0,
        routerCount: tcpRouters ? Object.keys(tcpRouters).length : 0,
        serviceCount: tcpServices ? Object.keys(tcpServices).length : 0,
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
    // Check if Consul service is available
    if (
      !coreServices.consulService ||
      !coreServices.consulService.isInitialized
    ) {
      return {
        valid: false,
        error: "Consul service not available",
      };
    }

    // Get TCP routers from Consul
    const tcpRouters = await coreServices.consulService.get("tcp/routers");

    // Check if any TCP routers exist (for MongoDB)
    const routersExist = tcpRouters && Object.keys(tcpRouters).length > 0;

    return {
      valid: routersExist,
      routersExist,
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
 * Check Consul health
 */
async function checkConsulHealth() {
  try {
    // Check if Consul container is running
    const containerStatus = await checkConsulContainer();

    return {
      containerRunning: containerStatus.running,
      status: containerStatus.running ? "active" : "inactive",
      containerDetails: containerStatus,
    };
  } catch (err) {
    logger.error(`Failed to check Consul health: ${err.message}`);
    return {
      containerRunning: false,
      status: "error",
      error: err.message,
    };
  }
}

/**
 * Check Consul container status
 */
async function checkConsulContainer() {
  try {
    const { stdout } = await execAsync(
      'docker ps -a --format "{{.Names}},{{.Status}},{{.Ports}}" --filter "name=consul"'
    );

    if (!stdout.trim()) {
      return {
        running: false,
        error: "No Consul container found",
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
    logger.error(`Failed to check Consul container: ${err.message}`);

    return {
      running: false,
      error: err.message,
    };
  }
}

/**
 * Check if Consul configuration is valid
 */
async function checkConsulConfig() {
  try {
    // Check if Consul service is available
    if (
      !coreServices.consulService ||
      !coreServices.consulService.isInitialized
    ) {
      return {
        valid: false,
        error: "Consul service not available",
      };
    }

    // Check if config has required sections in Consul
    const httpRouters = await coreServices.consulService.get("http/routers");
    const httpServices = await coreServices.consulService.get("http/services");

    const routersValid = httpRouters && Object.keys(httpRouters).length > 0;
    const servicesValid = httpServices && Object.keys(httpServices).length > 0;

    // Check Consul connectivity
    let consulHealthy = false;
    try {
      // Try to get Consul health info
      const { stdout } = await execAsync("docker exec consul consul members");
      consulHealthy = stdout.trim().length > 0;
    } catch (checkErr) {
      logger.warn(`Consul health check failed: ${checkErr.message}`);
      consulHealthy = false;
    }

    return {
      valid: routersValid && servicesValid && consulHealthy,
      details: {
        routersValid,
        servicesValid,
        consulHealthy,
      },
    };
  } catch (err) {
    logger.error(`Failed to check Consul config: ${err.message}`);

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
 * Restart Consul container
 */
async function restartConsul() {
  try {
    logger.info("Restarting Consul container");
    await execAsync("docker restart consul");
    return true;
  } catch (err) {
    logger.error(`Failed to restart Consul: ${err.message}`);
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

    // Check Consul health
    try {
      if (
        coreServices.consulService &&
        coreServices.consulService.isInitialized
      ) {
        // Check if Consul is accessible by retrieving a value
        const consulTest = await coreServices.consulService.get("http/routers");

        health.services.consul = {
          status: consulTest !== null ? "healthy" : "degraded",
          lastCheck: new Date().toISOString(),
        };

        // Check if Consul is running properly
        const consulHealth = await checkConsulHealth();

        health.services.consul = {
          status: consulHealth.containerRunning ? "healthy" : "unhealthy",
          containerRunning: consulHealth.containerRunning,
          lastCheck: new Date().toISOString(),
        };

        // Update overall health based on Consul status
        if (!consulTest || !consulHealth.containerRunning) {
          health.status = "degraded";
        }
      } else {
        health.services.consul = {
          status: "not_initialized",
          message: "Consul service is not initialized",
        };
        health.status = "degraded";
      }

      // Additional health metrics
      const systemLoad = os.loadavg()[0];
      const cpuCount = os.cpus().length;
      const loadPerCore = systemLoad / cpuCount;

      health.metrics = {
        cpu: {
          loadAvg: systemLoad,
          cores: cpuCount,
          loadPerCore: loadPerCore,
          highLoad: loadPerCore > 0.7, // Flag high load
        },
        memory: {
          total: os.totalmem(),
          free: os.freemem(),
          usage: 1 - os.freemem() / os.totalmem(),
          highUsage: os.freemem() / os.totalmem() < 0.2, // Flag high memory usage
        },
      };

      // Update status based on system metrics
      if (health.metrics.cpu.highLoad || health.metrics.memory.highUsage) {
        if (health.status === "healthy") {
          health.status = "stressed";
        }
      }
    } catch (error) {
      logger.error(`Error checking system health: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });

      health.status = "degraded";
      health.error = error.message;
    }

    res.status(200).json(health);
  } catch (error) {
    logger.error(`Error in getSystemHealth: ${error.message}`, {
      error: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      status: "error",
      timestamp: new Date().toISOString(),
      error: error.message,
    });
  }
};

/**
 * Recover Consul service
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.recoverConsulService = async (req, res) => {
  try {
    logger.info("Attempting to recover Consul service");

    if (!coreServices.consulService) {
      return res.status(500).json({
        success: false,
        message: "Consul service is not available",
      });
    }

    // Reinitialize the Consul service
    try {
      await coreServices.consulService.initialize();

      // Verify connection by getting a test value
      const testResult = await coreServices.consulService.get("http/routers");

      return res.status(200).json({
        success: true,
        message: "Consul service recovered successfully",
        connectionTest: testResult !== null,
      });
    } catch (error) {
      logger.error(`Failed to recover Consul service: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });

      return res.status(500).json({
        success: false,
        message: `Failed to recover Consul service: ${error.message}`,
      });
    }
  } catch (error) {
    logger.error(`Error in recoverConsulService: ${error.message}`, {
      error: error.message,
      stack: error.stack,
    });

    return res.status(500).json({
      success: false,
      message: `Error recovering Consul service: ${error.message}`,
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

    // Get Consul health
    try {
      if (
        coreServices.consulService &&
        coreServices.consulService.isInitialized
      ) {
        const forceRefresh = req.query.refresh === "true";
        const consulHealth = await checkConsulHealth();

        dashboard.components.consul = {
          status: consulHealth.status,
          lastCheck: new Date().toISOString(),
          containerRunning: consulHealth.containerRunning || false,
          configValid: (await checkConsulConfig()) || false,
        };

        // Update overall status based on Consul status
        if (consulHealth.status === "error") {
          dashboard.status = "critical";
          dashboard.alerts.push({
            component: "consul",
            severity: "critical",
            message: "Consul is unhealthy",
          });

          // Add recommendations for Consul issues
          dashboard.recommendations.push({
            component: "consul",
            action: "Run manual recovery",
            endpoint: "/api/health/consul/recover",
            description: "Attempt to automatically recover Consul service",
          });
        } else if (consulHealth.status === "inactive") {
          if (dashboard.status === "healthy") {
            dashboard.status = "degraded";
          }
          dashboard.alerts.push({
            component: "consul",
            severity: "warning",
            message: "Consul is not running",
          });
        }
      } else {
        dashboard.components.consul = {
          status: "unavailable",
          message: "Consul service is not initialized",
        };
        dashboard.status = "degraded";
      }
    } catch (err) {
      logger.error(`Failed to get Consul health: ${err.message}`);
      dashboard.components.consul = {
        status: "error",
        message: `Failed to get Consul health: ${err.message}`,
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
