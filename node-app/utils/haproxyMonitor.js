/**
 * HAProxy Monitoring Service
 *
 * Provides enhanced monitoring for HAProxy:
 * - Real-time health status tracking
 * - Performance metrics collection
 * - Status change notifications
 * - Automatic recovery attempts
 */

const EventEmitter = require("events");
const logger = require("./logger").getLogger("haproxyMonitor");
const { execAsync } = require("./exec");

// Health status constants
const STATUS = {
  UNKNOWN: "UNKNOWN",
  HEALTHY: "HEALTHY",
  UNHEALTHY: "UNHEALTHY",
  DEGRADED: "DEGRADED",
};

class HAProxyMonitor extends EventEmitter {
  /**
   * Create a new HAProxy monitor
   * @param {Object} options - Monitor options
   * @param {Object} options.apiClient - Configured axios client for HAProxy API
   * @param {string} options.containerName - HAProxy container name
   * @param {number} options.checkInterval - Health check interval in ms (default: 30000)
   * @param {number} options.unhealthyThreshold - Failures before marking unhealthy (default: 2)
   * @param {number} options.recoveryAttempts - Max auto-recovery attempts (default: 3)
   */
  constructor(options = {}) {
    super();

    this.apiClient = options.apiClient;
    this.containerName = options.containerName || "haproxy";
    this.checkInterval = options.checkInterval || 30000; // 30 seconds
    this.unhealthyThreshold = options.unhealthyThreshold || 2;
    this.recoveryAttempts = options.recoveryAttempts || 3;

    // Internal state
    this.status = STATUS.UNKNOWN;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastCheck = null;
    this.checkTimer = null;
    this.metrics = {
      connections: { current: 0, total: 0, rate: 0, limit: 0 },
      requests: { total: 0, rate: 0 },
      errors: { total: 0, rate: 0 },
      serverStates: {},
      uptime: 0,
      version: null,
    };
    this.recoveryAttemptCount = 0;
    this.alertSent = false;

    // Bind methods to this instance
    this.checkHealth = this.checkHealth.bind(this);
    this.attemptRecovery = this.attemptRecovery.bind(this);
  }

  /**
   * Start monitoring
   * @returns {HAProxyMonitor} This monitor instance
   */
  start() {
    logger.info(
      `Starting HAProxy monitoring with ${this.checkInterval / 1000}s interval`
    );
    this.stop(); // Clear any existing timer

    // Run an immediate check
    this.checkHealth();

    // Set up regular checks
    this.checkTimer = setInterval(this.checkHealth, this.checkInterval);

    return this;
  }

  /**
   * Stop monitoring
   * @returns {HAProxyMonitor} This monitor instance
   */
  stop() {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    return this;
  }

  /**
   * Run a comprehensive health check
   * @returns {Promise<Object>} Health check results
   */
  async checkHealth() {
    const startTime = Date.now();
    const health = {
      timestamp: new Date().toISOString(),
      status: STATUS.UNKNOWN,
      details: {
        apiConnected: false,
        containerRunning: false,
        configValid: false,
        processRunning: false,
        responseTime: 0,
        errors: [],
      },
    };

    try {
      // 1. Check if container is running
      try {
        const { stdout } = await execAsync(
          `docker ps -q -f name=${this.containerName}`
        );
        health.details.containerRunning = !!stdout.trim();

        if (!health.details.containerRunning) {
          health.details.errors.push("HAProxy container is not running");
        }
      } catch (err) {
        health.details.errors.push(`Container check error: ${err.message}`);
      }

      // 2. Check if HAProxy process is running inside container
      if (health.details.containerRunning) {
        try {
          const { stdout } = await execAsync(
            `docker exec ${this.containerName} pgrep -c haproxy || echo 0`
          );
          const processCount = parseInt(stdout.trim(), 10);
          health.details.processRunning = processCount > 0;

          if (!health.details.processRunning) {
            health.details.errors.push(
              "No HAProxy process running in container"
            );
          }
        } catch (err) {
          health.details.errors.push(`Process check error: ${err.message}`);
        }
      }

      // 3. Check Data Plane API connectivity
      if (this.apiClient) {
        try {
          const response = await this.apiClient.get("/info");
          health.details.apiConnected = response.status === 200;

          if (health.details.apiConnected && response.data) {
            health.details.version = response.data.version;
            this.metrics.version = response.data.version;

            if (response.data.processes) {
              health.details.processes = {
                running: response.data.processes.running || 0,
                total: response.data.processes.total || 0,
              };
            }
          }
        } catch (err) {
          health.details.errors.push(`API connection error: ${err.message}`);
        }
      }

      // 4. Check configuration validity
      if (health.details.containerRunning) {
        try {
          await execAsync(
            `docker exec ${this.containerName} haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg`
          );
          health.details.configValid = true;
        } catch (err) {
          health.details.configValid = false;
          health.details.errors.push(`Invalid configuration: ${err.message}`);
        }
      }

      // 5. Collect additional metrics if container is running
      if (health.details.containerRunning && health.details.processRunning) {
        await this.collectMetrics(health);
      }

      // Calculate response time
      health.details.responseTime = Date.now() - startTime;

      // Determine overall status
      if (!health.details.containerRunning || !health.details.processRunning) {
        health.status = STATUS.UNHEALTHY;
      } else if (!health.details.apiConnected || !health.details.configValid) {
        health.status = STATUS.DEGRADED;
      } else if (health.details.errors.length === 0) {
        health.status = STATUS.HEALTHY;
      } else {
        health.status = STATUS.DEGRADED;
      }

      // Update failure/success count
      if (health.status === STATUS.HEALTHY) {
        this.successCount++;
        this.failureCount = 0;
        this.alertSent = false; // Reset alert flag on recovery
      } else if (health.status === STATUS.UNHEALTHY) {
        this.failureCount++;
        this.successCount = 0;
      }

      // Update internal state
      const previousStatus = this.status;
      this.status = health.status;
      this.lastCheck = health;

      // Emit events based on status changes
      if (previousStatus !== health.status) {
        this.emit("status-changed", {
          previousStatus,
          currentStatus: health.status,
          health,
        });

        // If status changed to unhealthy, attempt recovery
        if (
          health.status === STATUS.UNHEALTHY &&
          this.recoveryAttemptCount < this.recoveryAttempts
        ) {
          this.attemptRecovery();
        }

        // If the status changed from unhealthy to healthy, emit recovery event
        if (
          previousStatus === STATUS.UNHEALTHY &&
          health.status === STATUS.HEALTHY
        ) {
          this.emit("recovered", health);
          this.recoveryAttemptCount = 0;
        }
      }

      // Send alert if consistently unhealthy and no alert sent yet
      if (
        health.status === STATUS.UNHEALTHY &&
        this.failureCount >= this.unhealthyThreshold &&
        !this.alertSent
      ) {
        this.emit("alert", {
          status: health.status,
          failures: this.failureCount,
          health,
        });
        this.alertSent = true;
      }

      return health;
    } catch (err) {
      logger.error(`Health check failed: ${err.message}`);

      // On error, mark as unhealthy
      this.status = STATUS.UNHEALTHY;
      this.failureCount++;
      this.lastCheck = {
        timestamp: new Date().toISOString(),
        status: STATUS.UNHEALTHY,
        details: { error: err.message },
      };

      return this.lastCheck;
    }
  }

  /**
   * Collect detailed metrics from HAProxy
   * @param {Object} health - Health check object to update
   * @returns {Promise<void>}
   * @private
   */
  async collectMetrics(health) {
    try {
      // Get connection stats from socat
      try {
        const { stdout } = await execAsync(
          `docker exec ${this.containerName} sh -c "echo 'show info' | socat unix-connect:/var/run/haproxy.sock stdio" | grep -E 'CurrConns|CumConns|Maxconn|Uptime|Process_num'`
        );

        const metrics = {};
        stdout.split("\n").forEach((line) => {
          const [key, value] = line.split(":").map((s) => s.trim());
          if (key && value !== undefined) {
            metrics[key] = parseInt(value, 10);
          }
        });

        health.details.connections = {
          current: metrics.CurrConns || 0,
          total: metrics.CumConns || 0,
          max: metrics.Maxconn || 0,
        };

        if (metrics.Uptime) {
          health.details.uptime = metrics.Uptime;
          this.metrics.uptime = metrics.Uptime;
        }

        this.metrics.connections = {
          current: metrics.CurrConns || 0,
          total: metrics.CumConns || 0,
          limit: metrics.Maxconn || 0,
        };
      } catch (err) {
        health.details.errors.push(
          `Failed to collect connection stats: ${err.message}`
        );
      }

      // Get backend status via API
      if (health.details.apiConnected) {
        try {
          const statsResponse = await this.apiClient.get(
            "/services/haproxy/stats"
          );

          if (statsResponse.status === 200 && statsResponse.data) {
            let backendErrors = 0;
            let backendDown = 0;
            let backendUp = 0;

            if (Array.isArray(statsResponse.data.data)) {
              statsResponse.data.data.forEach((item) => {
                if (item.type === "backend") {
                  this.metrics.serverStates[item.name] = {
                    status: item.status,
                    errors: parseInt(item.econ || 0, 10),
                    connections: parseInt(item.scur || 0, 10),
                  };

                  if (item.status !== "UP") {
                    backendDown++;
                  } else {
                    backendUp++;
                  }

                  backendErrors += parseInt(item.econ || 0, 10);
                }
              });
            }

            health.details.backends = {
              total: backendUp + backendDown,
              up: backendUp,
              down: backendDown,
              errors: backendErrors,
            };
          }
        } catch (err) {
          health.details.errors.push(
            `Failed to collect backend stats: ${err.message}`
          );
        }
      }
    } catch (err) {
      health.details.errors.push(`Failed to collect metrics: ${err.message}`);
    }
  }

  /**
   * Attempt to automatically recover HAProxy service
   * @returns {Promise<boolean>} Recovery success status
   */
  async attemptRecovery() {
    if (this.recoveryAttemptCount >= this.recoveryAttempts) {
      logger.warn(
        `Max recovery attempts (${this.recoveryAttempts}) reached, not attempting further recovery`
      );
      return false;
    }

    this.recoveryAttemptCount++;

    logger.info(
      `Attempting HAProxy recovery (attempt ${this.recoveryAttemptCount}/${this.recoveryAttempts})`
    );

    try {
      // First check if container is running
      const { stdout: containerId } = await execAsync(
        `docker ps -q -f name=${this.containerName}`
      );

      if (!containerId.trim()) {
        // Container is not running, try to start it
        logger.warn(`HAProxy container not running, attempting to start it`);
        await execAsync(`docker start ${this.containerName}`);

        // Wait a bit for container to start
        await new Promise((resolve) => setTimeout(resolve, 5000));

        // Check if container started successfully
        const { stdout: containerId } = await execAsync(
          `docker ps -q -f name=${this.containerName}`
        );
        if (!containerId.trim()) {
          throw new Error("Failed to start HAProxy container");
        }
      } else {
        // Container is running but service may be down, try to restart service
        logger.warn(
          "HAProxy container running but service may be down, attempting to restart service"
        );
        await execAsync(
          `docker exec ${this.containerName} service haproxy restart`
        );
      }

      // Wait for service to stabilize
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Check if recovery was successful
      const health = await this.checkHealth();

      if (health.status === STATUS.HEALTHY) {
        logger.info("HAProxy recovery successful");
        this.emit("recovery-success", {
          attempt: this.recoveryAttemptCount,
          health,
        });
        return true;
      } else {
        logger.warn(
          `HAProxy recovery attempt ${this.recoveryAttemptCount} failed`
        );
        this.emit("recovery-failed", {
          attempt: this.recoveryAttemptCount,
          health,
        });
        return false;
      }
    } catch (err) {
      logger.error(
        `HAProxy recovery attempt ${this.recoveryAttemptCount} failed: ${err.message}`
      );
      this.emit("recovery-failed", {
        attempt: this.recoveryAttemptCount,
        error: err.message,
      });
      return false;
    }
  }

  /**
   * Get current health status
   * @returns {Object} Current health status
   */
  getStatus() {
    return {
      status: this.status,
      lastCheck: this.lastCheck,
      metrics: this.metrics,
      failureCount: this.failureCount,
      successCount: this.successCount,
      recoveryAttemptCount: this.recoveryAttemptCount,
    };
  }

  /**
   * Force a service restart (for manual intervention)
   * @returns {Promise<boolean>} Restart success status
   */
  async restartService() {
    try {
      logger.info("Manually restarting HAProxy service");

      await execAsync(
        `docker exec ${this.containerName} service haproxy restart`
      );

      // Wait for service to stabilize
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Check health after restart
      const health = await this.checkHealth();

      return health.status === STATUS.HEALTHY;
    } catch (err) {
      logger.error(`Failed to restart HAProxy service: ${err.message}`);
      return false;
    }
  }

  /**
   * Register a callback for alerts
   * @param {Function} callback - Alert callback function
   * @returns {HAProxyMonitor} This monitor instance
   */
  onAlert(callback) {
    this.on("alert", callback);
    return this;
  }

  /**
   * Register a callback for status changes
   * @param {Function} callback - Status change callback function
   * @returns {HAProxyMonitor} This monitor instance
   */
  onStatusChange(callback) {
    this.on("status-changed", callback);
    return this;
  }

  /**
   * Register a callback for recovery events
   * @param {Function} callback - Recovery callback function
   * @returns {HAProxyMonitor} This monitor instance
   */
  onRecovery(callback) {
    this.on("recovered", callback);
    return this;
  }
}

module.exports = HAProxyMonitor;
