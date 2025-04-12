/**
 * HAProxy Recovery Manager
 *
 * Implements automated recovery strategies for HAProxy failures:
 * - Monitors HAProxy status via circuit breaker
 * - Detects failure patterns and applies appropriate recovery actions
 * - Implements exponential backoff for recovery attempts
 * - Provides recovery history and analytics
 */

const EventEmitter = require("events");
const { execAsync } = require("./exec");
const logger = require("./logger").getLogger("haproxyRecoveryManager");
const { withRetry } = require("./retryHandler");

class HAProxyRecoveryManager extends EventEmitter {
  /**
   * Create a new HAProxy recovery manager
   * @param {Object} options - Recovery manager options
   * @param {Object} options.circuitBreaker - HAProxy circuit breaker instance
   * @param {Object} options.monitor - HAProxy monitor instance
   * @param {Object} options.metricsCollector - HAProxy metrics collector instance
   * @param {string} options.containerName - HAProxy container name
   * @param {number} options.maxRecoveryAttempts - Max recovery attempts before giving up (default: 5)
   * @param {number} options.recoveryBackoff - Initial backoff in ms (default: 10000)
   * @param {number} options.maxBackoff - Maximum backoff in ms (default: 5 minutes)
   */
  constructor(options = {}) {
    super();

    this.circuitBreaker = options.circuitBreaker;
    this.monitor = options.monitor;
    this.metricsCollector = options.metricsCollector;
    this.containerName = options.containerName || "haproxy";
    this.maxRecoveryAttempts = options.maxRecoveryAttempts || 5;
    this.recoveryBackoff = options.recoveryBackoff || 10000; // 10 seconds
    this.maxBackoff = options.maxBackoff || 5 * 60 * 1000; // 5 minutes

    // Internal state
    this.recoveryAttempts = 0;
    this.lastRecoveryTime = null;
    this.currentBackoff = this.recoveryBackoff;
    this.recoveryTimer = null;
    this.recoveryHistory = [];
    this.recoveryEnabled = true;
    this.isRecovering = false;

    // Initialize event listeners if circuit breaker is provided
    if (this.circuitBreaker) {
      this.setupCircuitBreakerHandlers();
    }

    // Initialize event listeners if monitor is provided
    if (this.monitor) {
      this.setupMonitorHandlers();
    }
  }

  /**
   * Set up circuit breaker event handlers
   * @private
   */
  setupCircuitBreakerHandlers() {
    // Handle circuit breaker opening (service is failing)
    this.circuitBreaker.on("open", (event) => {
      logger.warn(`Circuit breaker opened: ${event.reason}`);

      if (this.recoveryEnabled && !this.isRecovering) {
        // Schedule recovery with current backoff
        this.scheduleRecovery();
      }
    });

    // Handle circuit breaker closing (service is healthy)
    this.circuitBreaker.on("close", () => {
      logger.info("Circuit breaker closed, service is healthy");

      // Reset recovery state on successful circuit closure
      this.resetRecoveryState();
    });
  }

  /**
   * Set up monitor event handlers
   * @private
   */
  setupMonitorHandlers() {
    // Handle monitor alerts (service issues detected)
    this.monitor.on("alert", (event) => {
      logger.warn(
        `Monitor alert: ${event.status} (${event.failures} failures)`
      );

      if (
        this.recoveryEnabled &&
        !this.isRecovering &&
        event.status === "UNHEALTHY"
      ) {
        // Schedule recovery with current backoff
        this.scheduleRecovery();
      }
    });

    // Handle successful recovery
    this.monitor.on("recovery-success", (event) => {
      logger.info(`Monitor recovery successful after attempt ${event.attempt}`);

      // Record successful recovery
      this.recordRecoveryAttempt(
        true,
        "MONITOR_RECOVERY",
        `Monitor recovery successful`
      );

      // Reset recovery state
      this.resetRecoveryState();
    });

    // Handle failed recovery
    this.monitor.on("recovery-failed", (event) => {
      logger.warn(`Monitor recovery failed, attempt ${event.attempt}`);

      // Record failed recovery
      this.recordRecoveryAttempt(
        false,
        "MONITOR_RECOVERY",
        `Monitor recovery failed: ${event.error || "unknown error"}`
      );

      // If monitor recovery failed, try our own recovery
      if (this.recoveryEnabled && !this.isRecovering) {
        this.scheduleRecovery();
      }
    });
  }

  /**
   * Schedule automatic recovery with exponential backoff
   * @private
   */
  scheduleRecovery() {
    // If already recovering or recovery disabled, don't schedule
    if (this.isRecovering || !this.recoveryEnabled) {
      return;
    }

    // If max recovery attempts reached, don't retry
    if (this.recoveryAttempts >= this.maxRecoveryAttempts) {
      logger.error(
        `Maximum recovery attempts (${this.maxRecoveryAttempts}) reached, giving up automatic recovery`
      );

      // Emit event for reaching max attempts
      this.emit("max-attempts-reached", {
        attempts: this.recoveryAttempts,
        history: this.recoveryHistory.slice(-this.maxRecoveryAttempts),
      });

      return;
    }

    // Clear any existing timer
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
    }

    // Calculate backoff with exponential increase and jitter
    const jitter = 0.5 + Math.random() * 0.5; // Random between 0.5 and 1
    const backoff = Math.min(this.maxBackoff, this.currentBackoff * jitter);

    logger.info(
      `Scheduling recovery attempt ${this.recoveryAttempts + 1}/${
        this.maxRecoveryAttempts
      } in ${Math.round(backoff / 1000)}s`
    );

    // Set recovery flag
    this.isRecovering = true;

    // Schedule recovery
    this.recoveryTimer = setTimeout(() => {
      this.performRecovery()
        .catch((err) => {
          logger.error(`Recovery attempt failed: ${err.message}`);
        })
        .finally(() => {
          this.isRecovering = false;

          // Increase backoff for next attempt
          this.currentBackoff = Math.min(
            this.maxBackoff,
            this.currentBackoff * 2
          );
        });
    }, backoff);

    // Emit scheduled event
    this.emit("recovery-scheduled", {
      attempt: this.recoveryAttempts + 1,
      backoff: Math.round(backoff / 1000),
      scheduled: new Date(Date.now() + backoff).toISOString(),
    });
  }

  /**
   * Perform recovery operations
   * @returns {Promise<Object>} Recovery result
   */
  async performRecovery() {
    // Increment attempt counter
    this.recoveryAttempts++;
    this.lastRecoveryTime = Date.now();

    logger.info(
      `Performing recovery attempt ${this.recoveryAttempts}/${this.maxRecoveryAttempts}`
    );

    try {
      // Emit start event
      this.emit("recovery-started", {
        attempt: this.recoveryAttempts,
        timestamp: new Date().toISOString(),
      });

      // First, check if there's a container issue
      const containerStatus = await this.checkContainerStatus();

      // If the container isn't running, try to start it
      if (!containerStatus.running) {
        logger.warn(`HAProxy container is not running, attempting to start`);

        const startResult = await this.startContainer();

        if (startResult.success) {
          logger.info("Successfully started HAProxy container");

          // Record successful recovery
          this.recordRecoveryAttempt(
            true,
            "CONTAINER_START",
            "Started HAProxy container"
          );

          // Wait for container to initialize
          await new Promise((resolve) => setTimeout(resolve, 5000));

          // Check health after container start
          const healthResult = await this.checkHealth();

          return {
            success: healthResult.healthy,
            action: "CONTAINER_START",
            message: healthResult.healthy
              ? "Container started and service is healthy"
              : "Container started but service is still unhealthy",
          };
        } else {
          logger.error(
            `Failed to start HAProxy container: ${startResult.error}`
          );

          // Record failed recovery
          this.recordRecoveryAttempt(
            false,
            "CONTAINER_START",
            `Failed to start container: ${startResult.error}`
          );

          return {
            success: false,
            action: "CONTAINER_START",
            message: "Failed to start HAProxy container",
            error: startResult.error,
          };
        }
      }

      // Container is running but service might be unhealthy
      // Try to restart HAProxy service inside the container
      logger.info(
        "HAProxy container is running, attempting to restart service"
      );

      const serviceResult = await this.restartService();

      if (serviceResult.success) {
        logger.info("Successfully restarted HAProxy service");

        // Record successful recovery
        this.recordRecoveryAttempt(
          true,
          "SERVICE_RESTART",
          "Restarted HAProxy service"
        );

        // Wait for service to initialize
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // Check health after service restart
        const healthResult = await this.checkHealth();

        if (!healthResult.healthy) {
          // Service is still unhealthy after restart, try a container restart
          logger.warn(
            "Service is still unhealthy after restart, attempting container restart"
          );

          const containerResult = await this.restartContainer();

          if (containerResult.success) {
            logger.info("Successfully restarted HAProxy container");

            // Record successful recovery
            this.recordRecoveryAttempt(
              true,
              "CONTAINER_RESTART",
              "Restarted HAProxy container"
            );

            // Wait for container to initialize
            await new Promise((resolve) => setTimeout(resolve, 5000));

            // Check health again
            const finalHealth = await this.checkHealth();

            return {
              success: finalHealth.healthy,
              action: "CONTAINER_RESTART",
              message: finalHealth.healthy
                ? "Container restarted and service is healthy"
                : "Container restarted but service is still unhealthy",
            };
          } else {
            logger.error(
              `Failed to restart HAProxy container: ${containerResult.error}`
            );

            // Record failed recovery
            this.recordRecoveryAttempt(
              false,
              "CONTAINER_RESTART",
              `Failed to restart container: ${containerResult.error}`
            );

            return {
              success: false,
              action: "CONTAINER_RESTART",
              message: "Failed to restart HAProxy container",
              error: containerResult.error,
            };
          }
        }

        return {
          success: true,
          action: "SERVICE_RESTART",
          message: "HAProxy service restarted successfully and is healthy",
        };
      } else {
        logger.error(
          `Failed to restart HAProxy service: ${serviceResult.error}`
        );

        // Record failed service restart
        this.recordRecoveryAttempt(
          false,
          "SERVICE_RESTART",
          `Failed to restart service: ${serviceResult.error}`
        );

        // Try a container restart as fallback
        logger.warn("Service restart failed, attempting container restart");

        const containerResult = await this.restartContainer();

        if (containerResult.success) {
          logger.info("Successfully restarted HAProxy container");

          // Record successful container restart
          this.recordRecoveryAttempt(
            true,
            "CONTAINER_RESTART",
            "Restarted HAProxy container"
          );

          // Wait for container to initialize
          await new Promise((resolve) => setTimeout(resolve, 5000));

          // Check health after container restart
          const healthResult = await this.checkHealth();

          return {
            success: healthResult.healthy,
            action: "CONTAINER_RESTART",
            message: healthResult.healthy
              ? "Container restarted and service is healthy"
              : "Container restarted but service is still unhealthy",
          };
        } else {
          logger.error(
            `Failed to restart HAProxy container: ${containerResult.error}`
          );

          // Record failed container restart
          this.recordRecoveryAttempt(
            false,
            "CONTAINER_RESTART",
            `Failed to restart container: ${containerResult.error}`
          );

          return {
            success: false,
            action: "CONTAINER_RESTART",
            message: "Failed to restart HAProxy service and container",
            error: containerResult.error,
          };
        }
      }
    } catch (err) {
      logger.error(
        `Recovery attempt ${this.recoveryAttempts} failed with error: ${err.message}`
      );

      // Record failed recovery
      this.recordRecoveryAttempt(
        false,
        "UNKNOWN",
        `Recovery failed with error: ${err.message}`
      );

      return {
        success: false,
        action: "ERROR",
        message: "Recovery failed with unexpected error",
        error: err.message,
      };
    } finally {
      // Emit completion event
      this.emit("recovery-completed", {
        attempt: this.recoveryAttempts,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Check HAProxy container status
   * @returns {Promise<Object>} Container status
   * @private
   */
  async checkContainerStatus() {
    try {
      const { stdout } = await execAsync(
        `docker ps -a --filter "name=${this.containerName}" --format "{{.Status}}"`
      );

      return {
        running: stdout.trim().startsWith("Up"),
        status: stdout.trim(),
      };
    } catch (err) {
      logger.error(`Failed to check container status: ${err.message}`);
      return {
        running: false,
        status: "Error",
        error: err.message,
      };
    }
  }

  /**
   * Start HAProxy container if stopped
   * @returns {Promise<Object>} Start result
   * @private
   */
  async startContainer() {
    try {
      await execAsync(`docker start ${this.containerName}`);
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Restart HAProxy container
   * @returns {Promise<Object>} Restart result
   * @private
   */
  async restartContainer() {
    return await withRetry(
      async () => {
        try {
          await execAsync(`docker restart ${this.containerName}`);
          return { success: true };
        } catch (err) {
          return {
            success: false,
            error: err.message,
          };
        }
      },
      {
        maxRetries: 2,
        initialDelay: 1000,
        shouldRetry: (err) => {
          return err && err.message && err.message.includes("resource busy");
        },
      }
    );
  }

  /**
   * Restart HAProxy service inside container
   * @returns {Promise<Object>} Restart result
   * @private
   */
  async restartService() {
    try {
      await execAsync(
        `docker exec ${this.containerName} service haproxy restart || docker exec ${this.containerName} /usr/sbin/haproxy -f /usr/local/etc/haproxy/haproxy.cfg -p /var/run/haproxy.pid -st \$(cat /var/run/haproxy.pid)`
      );
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Check HAProxy health
   * @returns {Promise<Object>} Health status
   * @private
   */
  async checkHealth() {
    try {
      // Use monitor if available
      if (this.monitor) {
        const health = await this.monitor.checkHealth();
        return {
          healthy: health.status === "HEALTHY",
          status: health.status,
          details: health,
        };
      }

      // Fallback to basic health check
      const containerStatus = await this.checkContainerStatus();
      if (!containerStatus.running) {
        return {
          healthy: false,
          status: "CONTAINER_DOWN",
          details: containerStatus,
        };
      }

      // Check if HAProxy process is running
      try {
        const { stdout } = await execAsync(
          `docker exec ${this.containerName} pgrep -c haproxy || echo 0`
        );
        const processCount = parseInt(stdout.trim(), 10);

        return {
          healthy: processCount > 0,
          status: processCount > 0 ? "HEALTHY" : "SERVICE_DOWN",
          details: { processCount },
        };
      } catch (err) {
        return {
          healthy: false,
          status: "CHECK_FAILED",
          details: { error: err.message },
        };
      }
    } catch (err) {
      logger.error(`Health check failed: ${err.message}`);
      return {
        healthy: false,
        status: "CHECK_ERROR",
        error: err.message,
      };
    }
  }

  /**
   * Record a recovery attempt in history
   * @param {boolean} success - Whether recovery was successful
   * @param {string} actionType - Type of recovery action
   * @param {string} message - Description of recovery
   * @private
   */
  recordRecoveryAttempt(success, actionType, message) {
    const attempt = {
      timestamp: new Date().toISOString(),
      attempt: this.recoveryAttempts,
      success,
      actionType,
      message,
    };

    this.recoveryHistory.push(attempt);

    // Keep history at a reasonable size
    if (this.recoveryHistory.length > 100) {
      this.recoveryHistory = this.recoveryHistory.slice(-100);
    }

    // Emit event
    this.emit(success ? "recovery-success" : "recovery-failure", attempt);
  }

  /**
   * Reset recovery state after successful recovery
   * @private
   */
  resetRecoveryState() {
    // Reset counters but keep history
    this.recoveryAttempts = 0;
    this.currentBackoff = this.recoveryBackoff;

    // Clear any pending recovery
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }

    this.isRecovering = false;

    logger.info("Reset recovery state after successful recovery");
  }

  /**
   * Enable automated recovery
   */
  enableRecovery() {
    this.recoveryEnabled = true;
    logger.info("Automated recovery enabled");
  }

  /**
   * Disable automated recovery
   */
  disableRecovery() {
    this.recoveryEnabled = false;

    // Clear any pending recovery
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }

    logger.info("Automated recovery disabled");
  }

  /**
   * Get recovery status
   * @returns {Object} Recovery status
   */
  getRecoveryStatus() {
    return {
      enabled: this.recoveryEnabled,
      isRecovering: this.isRecovering,
      attempts: this.recoveryAttempts,
      maxAttempts: this.maxRecoveryAttempts,
      lastRecoveryTime: this.lastRecoveryTime
        ? new Date(this.lastRecoveryTime).toISOString()
        : null,
      nextBackoff: Math.round(this.currentBackoff / 1000),
      history: this.recoveryHistory.slice(-10), // Return last 10 attempts
    };
  }

  /**
   * Manually trigger recovery process
   * @param {boolean} force - Force recovery even if disabled
   * @returns {Promise<Object>} Recovery result
   */
  async triggerRecovery(force = false) {
    if (!this.recoveryEnabled && !force) {
      return {
        success: false,
        message: "Automated recovery is disabled",
      };
    }

    if (this.isRecovering) {
      return {
        success: false,
        message: "Recovery is already in progress",
      };
    }

    logger.info("Manual recovery triggered");

    this.isRecovering = true;

    try {
      // Perform recovery immediately
      const result = await this.performRecovery();

      // If successful, reset recovery state
      if (result.success) {
        this.resetRecoveryState();
      }

      return result;
    } finally {
      this.isRecovering = false;
    }
  }
}

module.exports = HAProxyRecoveryManager;
