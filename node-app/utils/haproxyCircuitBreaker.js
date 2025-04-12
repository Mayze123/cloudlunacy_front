/**
 * HAProxy Circuit Breaker
 *
 * Implements the Circuit Breaker pattern for HAProxy operations
 * - Prevents cascading failures by failing fast
 * - Monitors health of HAProxy server
 * - Automatically resumes operations when server is healthy
 */

const logger = require("./logger").getLogger("haproxyCircuitBreaker");
const EventEmitter = require("events");

// Circuit states
const STATES = {
  CLOSED: "CLOSED", // Normal operation - requests go through
  OPEN: "OPEN", // Failing fast - requests are rejected immediately
  HALF_OPEN: "HALF_OPEN", // Testing if service is back - allowing a limited number of requests
};

class HAProxyCircuitBreaker extends EventEmitter {
  /**
   * Create a new circuit breaker for HAProxy operations
   * @param {Object} options - Circuit breaker options
   * @param {number} options.failureThreshold - Number of failures before opening circuit (default: 5)
   * @param {number} options.resetTimeout - Time in ms before attempting to close circuit (default: 30000)
   * @param {number} options.halfOpenMaxRequests - Max requests in half-open state (default: 3)
   * @param {Function} options.healthCheck - Function to check HAProxy health
   */
  constructor(options = {}) {
    super();

    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeout = options.resetTimeout || 30000; // 30 seconds
    this.halfOpenMaxRequests = options.halfOpenMaxRequests || 3;
    this.healthCheck = options.healthCheck || (() => Promise.resolve(true));

    this.state = STATES.CLOSED;
    this.failureCount = 0;
    this.resetTimer = null;
    this.halfOpenRequestCount = 0;
    this.lastFailure = null;
    this.lastStateChange = Date.now();

    this.healthCheckTimer = null;
    this.isPerformingHealthCheck = false;
  }

  /**
   * Start periodic health checks
   * @param {number} interval - Check interval in milliseconds
   */
  startHealthChecks(interval = 60000) {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    this.healthCheckTimer = setInterval(() => this.checkHealth(), interval);
    logger.info(
      `Started periodic HAProxy health checks every ${interval / 1000} seconds`
    );

    // Run an immediate check
    this.checkHealth();
  }

  /**
   * Stop periodic health checks
   */
  stopHealthChecks() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Check HAProxy health
   * @returns {Promise<boolean>} Is HAProxy healthy
   */
  async checkHealth() {
    // Prevent concurrent checks
    if (this.isPerformingHealthCheck) {
      return;
    }

    this.isPerformingHealthCheck = true;

    try {
      const isHealthy = await this.healthCheck();

      if (isHealthy) {
        // If the circuit is open and HAProxy is healthy, move to half-open
        if (this.state === STATES.OPEN) {
          this.toHalfOpen();
        }

        // If we're in half-open and HAProxy is healthy, we can close the circuit
        else if (this.state === STATES.HALF_OPEN) {
          this.close();
        }
      } else {
        // System is unhealthy - open the circuit if not already open
        if (this.state !== STATES.OPEN) {
          this.open("Health check failed");
        }
      }

      return isHealthy;
    } catch (err) {
      logger.error(`Health check error: ${err.message}`);

      // Health check failed - open the circuit if not already open
      if (this.state !== STATES.OPEN) {
        this.open(`Health check error: ${err.message}`);
      }

      return false;
    } finally {
      this.isPerformingHealthCheck = false;
    }
  }

  /**
   * Execute an operation with circuit breaker protection
   * @param {Function} fn - Operation to execute
   * @param {string} operationName - Name of the operation for logging
   * @returns {Promise<any>} Result of the operation
   */
  async execute(fn, operationName = "Unknown Operation") {
    if (this.state === STATES.OPEN) {
      // Circuit is open - fail fast
      const err = new Error(
        `Circuit is open. Operation rejected: ${operationName}`
      );
      err.code = "CIRCUIT_OPEN";
      err.circuitBreakerState = this.getStatus();
      logger.warn(`Rejecting operation ${operationName} - circuit is open`);
      throw err;
    }

    if (
      this.state === STATES.HALF_OPEN &&
      this.halfOpenRequestCount >= this.halfOpenMaxRequests
    ) {
      // Circuit is half-open but we've reached the request limit
      const err = new Error(
        `Half-open circuit reached request limit. Operation rejected: ${operationName}`
      );
      err.code = "CIRCUIT_HALF_OPEN_LIMIT";
      err.circuitBreakerState = this.getStatus();
      logger.warn(
        `Rejecting operation ${operationName} - half-open circuit at request limit`
      );
      throw err;
    }

    // Increment request counter if in half-open state
    if (this.state === STATES.HALF_OPEN) {
      this.halfOpenRequestCount++;
    }

    try {
      // Execute the operation
      const result = await fn();

      // Success - reset failure count
      this.handleSuccess();

      return result;
    } catch (err) {
      // Handle failure
      this.handleFailure(err, operationName);
      throw err;
    }
  }

  /**
   * Handle operation success
   */
  handleSuccess() {
    // Reset failure count on success
    this.failureCount = 0;

    // If circuit was half-open, successful operation means we can close the circuit
    if (this.state === STATES.HALF_OPEN) {
      this.close();
    }
  }

  /**
   * Handle operation failure
   * @param {Error} err - Error that occurred
   * @param {string} operationName - Name of the failed operation
   */
  handleFailure(err, operationName) {
    this.lastFailure = {
      error: err.message,
      time: Date.now(),
      operation: operationName,
    };

    // Increment failure count
    this.failureCount++;

    // Log the failure
    logger.warn(
      `Operation failed: ${operationName} - ${err.message} (failure ${this.failureCount}/${this.failureThreshold})`
    );

    // If we're in half-open state and an operation fails, reopen the circuit
    if (this.state === STATES.HALF_OPEN) {
      this.open(`Failed operation in half-open state: ${operationName}`);
      return;
    }

    // If we're in closed state and have reached the failure threshold, open the circuit
    if (
      this.state === STATES.CLOSED &&
      this.failureCount >= this.failureThreshold
    ) {
      this.open(
        `Failure threshold reached: ${this.failureCount}/${this.failureThreshold}`
      );
    }
  }

  /**
   * Open the circuit
   * @param {string} reason - Reason for opening the circuit
   */
  open(reason) {
    if (this.state === STATES.OPEN) {
      return; // Already open
    }

    logger.warn(`Opening circuit: ${reason}`);

    // Clear any existing reset timer
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
    }

    // Set state to OPEN
    this.state = STATES.OPEN;
    this.lastStateChange = Date.now();

    // Emit state change event
    this.emit("open", { reason, lastFailure: this.lastFailure });

    // Set timer to try half-open
    this.resetTimer = setTimeout(() => {
      this.toHalfOpen();
    }, this.resetTimeout);
  }

  /**
   * Switch to half-open state
   */
  toHalfOpen() {
    if (this.state === STATES.HALF_OPEN) {
      return; // Already half-open
    }

    logger.info("Transitioning circuit to half-open state");

    // Reset half-open request count
    this.halfOpenRequestCount = 0;

    // Set state to HALF_OPEN
    this.state = STATES.HALF_OPEN;
    this.lastStateChange = Date.now();

    // Emit state change event
    this.emit("half-open");
  }

  /**
   * Close the circuit
   */
  close() {
    if (this.state === STATES.CLOSED) {
      return; // Already closed
    }

    logger.info("Closing circuit - service appears stable");

    // Clear any existing reset timer
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }

    // Reset counters
    this.failureCount = 0;
    this.halfOpenRequestCount = 0;

    // Set state to CLOSED
    this.state = STATES.CLOSED;
    this.lastStateChange = Date.now();

    // Emit state change event
    this.emit("close");
  }

  /**
   * Reset the circuit breaker to closed state
   */
  reset() {
    // Clear reset timer
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }

    // Reset counters
    this.failureCount = 0;
    this.halfOpenRequestCount = 0;

    // Set state to CLOSED
    const previousState = this.state;
    this.state = STATES.CLOSED;
    this.lastStateChange = Date.now();

    logger.info(
      `Circuit breaker manually reset from ${previousState} to CLOSED`
    );

    // Emit state change event
    this.emit("reset");
    this.emit("close");
  }

  /**
   * Get current status of the circuit breaker
   * @returns {Object} Status information
   */
  getStatus() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      failureThreshold: this.failureThreshold,
      lastStateChange: this.lastStateChange,
      halfOpenRequestCount: this.halfOpenRequestCount,
      halfOpenMaxRequests: this.halfOpenMaxRequests,
      lastFailure: this.lastFailure,
      upTime: Date.now() - this.lastStateChange,
    };
  }
}

module.exports = HAProxyCircuitBreaker;
