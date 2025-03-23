/**
 * Retry Handler Utility
 *
 * Provides robust retry mechanisms with exponential backoff for error recovery
 */

const logger = require("./logger").getLogger("retryHandler");
const { AppError } = require("./errorHandler");

/**
 * Retry a function with exponential backoff
 *
 * @param {Function} fn - Async function to retry
 * @param {Object} options - Retry options
 * @param {number} options.maxRetries - Maximum number of retries (default: 3)
 * @param {number} options.initialDelay - Initial delay in ms (default: 1000)
 * @param {number} options.maxDelay - Maximum delay in ms (default: 30000)
 * @param {Function} options.shouldRetry - Function to determine if retry should be attempted (default: always retry)
 * @param {Function} options.onRetry - Function called before each retry attempt
 * @param {boolean} options.throwAppError - Whether to throw an AppError instead of the original error (default: true)
 * @param {number} options.errorStatusCode - Status code to use if throwing an AppError (default: 500)
 * @returns {Promise<any>} - Result of the function call
 */
async function withRetry(fn, options = {}) {
  const maxRetries = options.maxRetries || 3;
  const initialDelay = options.initialDelay || 1000;
  const maxDelay = options.maxDelay || 30000;
  const shouldRetry = options.shouldRetry || (() => true);
  const onRetry = options.onRetry || (() => {});
  const throwAppError = options.throwAppError !== false;
  const errorStatusCode = options.errorStatusCode || 500;

  let attemptCount = 0;
  let lastError = null;

  while (attemptCount <= maxRetries) {
    try {
      if (attemptCount > 0) {
        // Log retry attempt
        logger.info(`Retry attempt ${attemptCount}/${maxRetries}`);
      }

      // Call the function
      return await fn();
    } catch (err) {
      lastError = err;
      attemptCount++;

      // Add error details to log
      logger.error(`Error occurred: ${err.message}`, {
        error: err.message,
        stack: err.stack,
        attempt: attemptCount,
        maxRetries,
      });

      // Check if we should retry
      if (attemptCount > maxRetries || !shouldRetry(err, attemptCount)) {
        logger.error(
          `Max retries (${maxRetries}) reached or retry not advised. Giving up.`
        );
        break;
      }

      // Calculate delay with exponential backoff and jitter
      const delay = Math.min(
        maxDelay,
        initialDelay *
          Math.pow(2, attemptCount - 1) *
          (0.5 + Math.random() * 0.5)
      );

      logger.info(`Retrying in ${Math.round(delay)}ms...`);

      // Call onRetry hook if provided
      if (onRetry) {
        try {
          await onRetry(err, attemptCount, delay);
        } catch (hookError) {
          logger.warn(`Error in onRetry hook: ${hookError.message}`);
        }
      }

      // Wait for the delay period
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // If we've reached here, all retries failed
  if (throwAppError && !(lastError instanceof AppError)) {
    // Transform to AppError if it's not already one
    throw new AppError(
      `Operation failed after ${maxRetries} retries: ${lastError.message}`,
      errorStatusCode,
      { originalError: lastError }
    );
  }
  throw lastError;
}

/**
 * Execute a function with a timeout
 *
 * @param {Function} fn - Async function to execute
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {boolean} throwAppError - Whether to throw an AppError on timeout (default: true)
 * @returns {Promise<any>} - Result of the function call
 */
async function withTimeout(fn, timeoutMs, throwAppError = true) {
  return new Promise(async (resolve, reject) => {
    const timeoutId = setTimeout(() => {
      const timeoutError = new Error(
        `Operation timed out after ${timeoutMs}ms`
      );
      if (throwAppError) {
        reject(new AppError(`Operation timed out after ${timeoutMs}ms`, 408));
      } else {
        reject(timeoutError);
      }
    }, timeoutMs);

    try {
      const result = await fn();
      clearTimeout(timeoutId);
      resolve(result);
    } catch (err) {
      clearTimeout(timeoutId);
      reject(err);
    }
  });
}

/**
 * Wrap a function with circuit breaker pattern
 *
 * @param {Function} fn - Function to wrap
 * @param {Object} options - Circuit breaker options
 * @param {number} options.failureThreshold - Number of failures before opening circuit (default: 3)
 * @param {number} options.resetTimeout - Time in ms before trying to close circuit (default: 30000)
 * @param {boolean} options.throwAppError - Whether to throw AppError instead of generic error (default: true)
 * @returns {Function} - Wrapped function with circuit breaker
 */
function circuitBreaker(fn, options = {}) {
  const state = {
    failures: 0,
    status: "CLOSED", // CLOSED, OPEN, HALF-OPEN
    lastFailure: null,
  };

  const failureThreshold = options.failureThreshold || 3;
  const resetTimeout = options.resetTimeout || 30000;
  const throwAppError = options.throwAppError !== false;

  return async function (...args) {
    // If circuit is open, check if we should try to close it
    if (state.status === "OPEN") {
      const timeSinceLastFailure = Date.now() - state.lastFailure;
      if (timeSinceLastFailure < resetTimeout) {
        logger.warn(
          `Circuit is OPEN (${Math.round(
            timeSinceLastFailure / 1000
          )}s ago). Fast failing.`
        );
        if (throwAppError) {
          throw new AppError("Circuit is open - service unavailable", 503);
        } else {
          throw new Error("Circuit is open - service unavailable");
        }
      }

      // Move to half-open state to test if service is healthy
      logger.info("Moving circuit to HALF-OPEN state to test service");
      state.status = "HALF-OPEN";
    }

    try {
      // Call the function
      const result = await fn(...args);

      // If successful and in half-open, close the circuit
      if (state.status === "HALF-OPEN") {
        logger.info("Circuit test successful, closing circuit");
        state.failures = 0;
        state.status = "CLOSED";
      }

      return result;
    } catch (err) {
      // Record failure
      state.failures++;
      state.lastFailure = Date.now();

      // If in half-open or enough failures, open the circuit
      if (state.status === "HALF-OPEN" || state.failures >= failureThreshold) {
        logger.error(`Circuit opening after ${state.failures} failures`);
        state.status = "OPEN";
      }

      throw err;
    }
  };
}

/**
 * Bulk operation handler with parallelism control and error aggregation
 *
 * @param {Array} items - Items to process
 * @param {Function} fn - Async function to call for each item
 * @param {Object} options - Options
 * @param {number} options.concurrency - Max concurrent operations (default: 3)
 * @param {boolean} options.stopOnError - Whether to stop on first error (default: false)
 * @returns {Promise<Object>} - Results and errors
 */
async function bulkOperation(items, fn, options = {}) {
  const concurrency = options.concurrency || 3;
  const stopOnError = options.stopOnError || false;

  const results = [];
  const errors = [];
  let activeCount = 0;
  let index = 0;

  return new Promise((resolve, reject) => {
    // Process function for each item
    const processNext = async () => {
      if (index >= items.length) {
        // If all tasks are done, resolve
        if (activeCount === 0) {
          resolve({
            success: errors.length === 0,
            results,
            errors,
            total: items.length,
            succeeded: results.length,
            failed: errors.length,
          });
        }
        return;
      }

      // Get next item
      const currentIndex = index++;
      const item = items[currentIndex];
      activeCount++;

      try {
        // Process item
        const result = await fn(item, currentIndex);
        results.push({ item, result });
      } catch (error) {
        // Record error
        errors.push({ item, error });

        // If stopOnError, reject immediately
        if (stopOnError) {
          return reject(error);
        }
      } finally {
        activeCount--;

        // Process next item
        processNext();
      }
    };

    // Start initial batch of tasks
    for (let i = 0; i < Math.min(concurrency, items.length); i++) {
      processNext();
    }
  });
}

module.exports = {
  withRetry,
  withTimeout,
  circuitBreaker,
  bulkOperation,
};
