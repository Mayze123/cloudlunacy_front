/**
 * Certificate Circuit Breaker
 *
 * Implements the circuit breaker pattern for certificate operations:
 * - Prevents cascading failures when certificate services are unavailable
 * - Tracks success/failure rates and trips circuit when failures exceed threshold
 * - Provides automatic recovery with health check polling
 * - Implements rate limiting for different operation types
 */

const EventEmitter = require("events");
const logger = require("./logger").getLogger("certificateCircuitBreaker");

// Circuit states
const STATE = {
  CLOSED: "CLOSED", // Normal operation, requests pass through
  OPEN: "OPEN", // Circuit is open, requests fail fast
  HALF_OPEN: "HALF_OPEN", // Testing if service is back online
};

class CertificateCircuitBreaker extends EventEmitter {
  /**
   * Create a new certificate circuit breaker
   * @param {Object} options - Circuit breaker options
   * @param {number} options.failureThreshold - Number of failures before opening circuit
   * @param {number} options.resetTimeout - Time in ms before attempting to close circuit
   * @param {Function} options.healthCheck - Function that returns a Promise resolving to a boolean
   * @param {number} options.healthCheckInterval - Time in ms between health checks when open
   * @param {Object} options.rateLimits - Rate limits by operation type
   */
  constructor(options = {}) {
    super();

    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeout = options.resetTimeout || 30000; // 30 seconds default
    this.healthCheck = options.healthCheck || (() => Promise.resolve(true));
    this.healthCheckInterval = options.healthCheckInterval || 60000; // 1 minute default

    // Rate limits by operation type
    this.rateLimits = options.rateLimits || {
      issue: { limit: 5, period: 3600000 }, // 5 per hour
      renew: { limit: 10, period: 3600000 }, // 10 per hour
      revoke: { limit: 3, period: 3600000 }, // 3 per hour
    };

    // Circuit state
    this.state = STATE.CLOSED;
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.lastHealthCheckTime = null;
    this.nextAttemptTime = null;
    this.healthCheckIntervalId = null;

    // Rate limiting state
    this.operationCounts = {
      issue: [],
      renew: [],
      revoke: [],
    };
  }

  /**
   * Execute a function with circuit breaker protection
   * @param {Function} fn - Function to execute
   * @param {string} operationName - Name of operation (for logging)
   * @param {string} operationType - Type of operation (for rate limiting)
   * @returns {Promise<any>} Result of the function
   * @throws {Error} If circuit is open or rate limit exceeded
   */
  async execute(
    fn,
    operationName = "certificate operation",
    operationType = null
  ) {
    // Check circuit state
    if (this.state === STATE.OPEN) {
      const error = new Error(`Circuit breaker is open for ${operationName}`);
      error.code = "CIRCUIT_OPEN";
      logger.warn(`Fast fail for ${operationName}: circuit is open`);
      throw error;
    }

    // Check rate limit if operation type is specified
    if (operationType && this.rateLimits[operationType]) {
      if (this._isRateLimited(operationType)) {
        const limit = this.rateLimits[operationType];
        const error = new Error(
          `Rate limit exceeded for ${operationType} operations (${
            limit.limit
          } per ${limit.period / 60000} minutes)`
        );
        error.code = "RATE_LIMIT_EXCEEDED";
        logger.warn(`Rate limit exceeded for ${operationType} operations`);
        throw error;
      }
    }

    // Execute the function
    try {
      logger.debug(`Executing ${operationName} through circuit breaker`);
      const result = await fn();

      // Reset failure count on success
      if (this.state === STATE.HALF_OPEN) {
        this._closeCircuit();
      } else {
        this.failureCount = 0;
      }

      // Record operation for rate limiting
      if (operationType) {
        this._recordOperation(operationType);
      }

      return result;
    } catch (err) {
      logger.error(
        `Circuit breaker caught error in ${operationName}: ${err.message}`
      );

      // Increment failure count
      this.failureCount++;
      this.lastFailureTime = Date.now();

      // Check if threshold exceeded
      if (
        this.state === STATE.CLOSED &&
        this.failureCount >= this.failureThreshold
      ) {
        this._openCircuit();
      } else if (this.state === STATE.HALF_OPEN) {
        // If fails in half-open state, reopen the circuit
        this._openCircuit();
      }

      // Emit the error event
      this.emit("failure", {
        operation: operationName,
        error: err.message,
        failureCount: this.failureCount,
        circuitState: this.state,
      });

      throw err;
    }
  }

  /**
   * Get circuit breaker status
   * @returns {Object} Current status
   */
  getStatus() {
    const now = Date.now();
    let timeUntilReset = 0;

    if (this.state === STATE.OPEN && this.nextAttemptTime) {
      timeUntilReset = Math.max(0, this.nextAttemptTime - now);
    }

    // Calculate remaining rate limits
    const rateLimits = {};
    Object.keys(this.rateLimits).forEach((type) => {
      const limit = this.rateLimits[type];
      const counts = this.operationCounts[type];
      const validCounts = counts.filter((time) => now - time < limit.period);
      rateLimits[type] = {
        limit: limit.limit,
        remaining: Math.max(0, limit.limit - validCounts.length),
        resetIn:
          validCounts.length > 0
            ? limit.period - (now - Math.min(...validCounts))
            : 0,
      };
    });

    return {
      state: this.state,
      failureCount: this.failureCount,
      failureThreshold: this.failureThreshold,
      lastFailure: this.lastFailureTime
        ? new Date(this.lastFailureTime).toISOString()
        : null,
      lastHealthCheck: this.lastHealthCheckTime
        ? new Date(this.lastHealthCheckTime).toISOString()
        : null,
      timeUntilReset: Math.round(timeUntilReset / 1000), // in seconds
      rateLimits,
    };
  }

  /**
   * Start automatic health checking
   */
  startHealthChecks() {
    if (this.healthCheckIntervalId) {
      clearInterval(this.healthCheckIntervalId);
    }

    this.healthCheckIntervalId = setInterval(async () => {
      if (this.state === STATE.OPEN) {
        await this._performHealthCheck();
      }
    }, this.healthCheckInterval);

    // Prevent timer from blocking Node exit
    if (this.healthCheckIntervalId.unref) {
      this.healthCheckIntervalId.unref();
    }

    logger.debug(
      `Started health checks with interval of ${this.healthCheckInterval}ms`
    );
  }

  /**
   * Stop automatic health checking
   */
  stopHealthChecks() {
    if (this.healthCheckIntervalId) {
      clearInterval(this.healthCheckIntervalId);
      this.healthCheckIntervalId = null;
      logger.debug("Stopped health checks");
    }
  }

  /**
   * Force circuit open (for testing or manual control)
   * @param {string} reason - Reason for opening circuit
   */
  forceOpen(reason = "Manual control") {
    const previousState = this.state;
    this.state = STATE.OPEN;
    this.nextAttemptTime = Date.now() + this.resetTimeout;

    logger.info(`Circuit manually opened: ${reason}`);

    this.emit("open", {
      previousState,
      reason,
      nextAttemptTime: new Date(this.nextAttemptTime).toISOString(),
    });
  }

  /**
   * Force circuit closed (for testing or manual control)
   * @param {string} reason - Reason for closing circuit
   */
  forceClose(reason = "Manual control") {
    const previousState = this.state;
    this.state = STATE.CLOSED;
    this.failureCount = 0;
    this.nextAttemptTime = null;

    logger.info(`Circuit manually closed: ${reason}`);

    this.emit("close", {
      previousState,
      reason,
    });
  }

  /**
   * Reset rate limits (for testing or manual control)
   * @param {string} [operationType] - Specific operation type to reset, or all if not specified
   */
  resetRateLimits(operationType = null) {
    if (operationType && this.operationCounts[operationType]) {
      this.operationCounts[operationType] = [];
      logger.info(`Rate limit for ${operationType} operations reset`);
    } else {
      Object.keys(this.operationCounts).forEach((type) => {
        this.operationCounts[type] = [];
      });
      logger.info("All rate limits reset");
    }
  }

  /**
   * Record an operation for rate limiting
   * @param {string} operationType - Type of operation
   * @private
   */
  _recordOperation(operationType) {
    if (this.operationCounts[operationType]) {
      const now = Date.now();
      const limit = this.rateLimits[operationType];

      // Add the current time
      this.operationCounts[operationType].push(now);

      // Clean up old entries
      this.operationCounts[operationType] = this.operationCounts[
        operationType
      ].filter((time) => now - time < limit.period);
    }
  }

  /**
   * Check if an operation would exceed rate limits
   * @param {string} operationType - Type of operation
   * @returns {boolean} True if rate limited
   * @private
   */
  _isRateLimited(operationType) {
    if (
      !this.operationCounts[operationType] ||
      !this.rateLimits[operationType]
    ) {
      return false;
    }

    const now = Date.now();
    const limit = this.rateLimits[operationType];

    // Clean up old entries
    this.operationCounts[operationType] = this.operationCounts[
      operationType
    ].filter((time) => now - time < limit.period);

    // Check if limit is exceeded
    return this.operationCounts[operationType].length >= limit.limit;
  }

  /**
   * Open the circuit
   * @private
   */
  _openCircuit() {
    const previousState = this.state;
    this.state = STATE.OPEN;
    this.nextAttemptTime = Date.now() + this.resetTimeout;

    logger.warn(`Circuit opened after ${this.failureCount} failures`);

    this.emit("open", {
      previousState,
      failureCount: this.failureCount,
      nextAttemptTime: new Date(this.nextAttemptTime).toISOString(),
    });

    // Schedule automatic attempt to half-open after reset timeout
    setTimeout(() => {
      if (this.state === STATE.OPEN) {
        this._halfOpenCircuit();
      }
    }, this.resetTimeout);
  }

  /**
   * Set circuit to half-open state
   * @private
   */
  _halfOpenCircuit() {
    const previousState = this.state;
    this.state = STATE.HALF_OPEN;

    logger.info("Circuit half-opened, will test next request");

    this.emit("half-open", {
      previousState,
    });
  }

  /**
   * Close the circuit
   * @private
   */
  _closeCircuit() {
    const previousState = this.state;
    this.state = STATE.CLOSED;
    this.failureCount = 0;
    this.nextAttemptTime = null;

    logger.info("Circuit closed, resuming normal operation");

    this.emit("close", {
      previousState,
    });
  }

  /**
   * Perform a health check
   * @returns {Promise<boolean>} Health check result
   * @private
   */
  async _performHealthCheck() {
    logger.debug("Performing health check");
    this.lastHealthCheckTime = Date.now();

    try {
      const isHealthy = await this.healthCheck();

      logger.debug(
        `Health check result: ${isHealthy ? "healthy" : "unhealthy"}`
      );

      if (isHealthy && this.state === STATE.OPEN) {
        this._halfOpenCircuit();
      }

      return isHealthy;
    } catch (err) {
      logger.error(`Health check failed: ${err.message}`);
      return false;
    }
  }
}

module.exports = CertificateCircuitBreaker;
