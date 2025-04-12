/**
 * HAProxy Transaction Manager
 *
 * Provides atomic configuration changes to HAProxy with transaction management:
 * - Coordinates multi-step configuration changes as atomic units
 * - Implements automatic rollback on failures
 * - Maintains transaction history for auditing
 * - Prevents configuration conflicts between concurrent operations
 */

const EventEmitter = require("events");
const { v4: uuidv4 } = require("uuid");
const { withRetry } = require("./retryHandler");
const logger = require("./logger").getLogger("haproxyTransactionManager");

class HAProxyTransactionManager extends EventEmitter {
  /**
   * Create a new HAProxy transaction manager
   * @param {Object} options - Configuration options
   * @param {Object} options.apiClient - HAProxy Data Plane API client
   * @param {Number} options.transactionTimeout - Transaction timeout in ms (default: 30s)
   * @param {Number} options.maxRetries - Maximum retries for API operations (default: 3)
   * @param {Number} options.retryDelay - Delay between retries in ms (default: 1000)
   * @param {Boolean} options.validateConfig - Validate configuration before commit (default: true)
   */
  constructor(options = {}) {
    super();

    this.apiClient = options.apiClient;
    this.transactionTimeout = options.transactionTimeout || 30000; // 30 seconds
    this.maxRetries = options.maxRetries || 3;
    this.retryDelay = options.retryDelay || 1000;
    this.validateConfig = options.validateConfig !== false;

    // Transaction tracking
    this.activeTransactions = new Map();
    this.transactionHistory = [];
    this.transactionTimeouts = new Map();

    // Lock management for concurrent operations
    this.locks = new Map();

    // Bind methods
    this.cleanupTransaction = this.cleanupTransaction.bind(this);
  }

  /**
   * Begin a new transaction
   * @param {string} description - Optional transaction description
   * @param {Object} metadata - Optional transaction metadata
   * @returns {Promise<Object>} Transaction object
   */
  async beginTransaction(description = "", metadata = {}) {
    try {
      if (!this.apiClient) {
        throw new Error("API client is required for transaction management");
      }

      // Create transaction in HAProxy
      const response = await withRetry(
        () => this.apiClient.post("/services/haproxy/transactions"),
        { retries: this.maxRetries, delay: this.retryDelay }
      );

      const transactionId = response.data.data.id;
      const transactionKey = `tx_${transactionId}`;

      // Record transaction details
      const transaction = {
        id: transactionId,
        key: transactionKey,
        description: description,
        metadata: { ...metadata },
        startTime: new Date().toISOString(),
        status: "active",
        changes: [],
        endTime: null,
        error: null,
      };

      // Track active transaction
      this.activeTransactions.set(transactionKey, transaction);

      // Set transaction timeout
      const timeoutId = setTimeout(
        () => this.handleTransactionTimeout(transactionKey),
        this.transactionTimeout
      );

      this.transactionTimeouts.set(transactionKey, timeoutId);

      logger.info(
        `Started transaction ${transactionId}${
          description ? ` (${description})` : ""
        }`
      );

      // Emit transaction started event
      this.emit("transaction-started", {
        transaction: { ...transaction },
        timestamp: new Date().toISOString(),
      });

      return transaction;
    } catch (err) {
      logger.error(`Failed to begin transaction: ${err.message}`);
      throw err;
    }
  }

  /**
   * Commit a transaction
   * @param {string} transactionKey - Transaction key
   * @param {boolean} force - Force commit even if validation fails
   * @returns {Promise<Object>} Commit result
   */
  async commitTransaction(transactionKey, force = false) {
    const transaction = this.activeTransactions.get(transactionKey);

    if (!transaction) {
      throw new Error(
        `Transaction ${transactionKey} not found or already completed`
      );
    }

    try {
      logger.info(`Committing transaction ${transaction.id}`);

      // Validate configuration before commit if enabled
      if (this.validateConfig && !force) {
        const validationResult = await this.validateConfiguration(
          transaction.id
        );

        if (!validationResult.valid) {
          logger.error(
            `Transaction ${transaction.id} validation failed: ${validationResult.message}`
          );

          // Automatically rollback invalid transactions
          await this.rollbackTransaction(
            transactionKey,
            `Validation failed: ${validationResult.message}`
          );

          throw new Error(
            `Configuration validation failed: ${validationResult.message}`
          );
        }
      }

      // Commit the transaction
      await withRetry(
        () =>
          this.apiClient.put(
            `/services/haproxy/transactions/${transaction.id}`
          ),
        { retries: this.maxRetries, delay: this.retryDelay }
      );

      // Update transaction
      transaction.status = "committed";
      transaction.endTime = new Date().toISOString();

      // Add to history and remove from active
      this.transactionHistory.push(transaction);
      this.activeTransactions.delete(transactionKey);

      // Clear timeout
      this.cleanupTransaction(transactionKey);

      logger.info(`Transaction ${transaction.id} committed successfully`);

      // Emit transaction committed event
      this.emit("transaction-committed", {
        transaction: { ...transaction },
        timestamp: new Date().toISOString(),
      });

      return {
        success: true,
        transaction: { ...transaction },
      };
    } catch (err) {
      logger.error(
        `Failed to commit transaction ${transaction.id}: ${err.message}`
      );

      // Don't rollback here, let the caller decide what to do
      // The transaction is still active

      throw err;
    }
  }

  /**
   * Rollback a transaction
   * @param {string} transactionKey - Transaction key
   * @param {string} reason - Rollback reason
   * @returns {Promise<Object>} Rollback result
   */
  async rollbackTransaction(transactionKey, reason = "Manual rollback") {
    const transaction = this.activeTransactions.get(transactionKey);

    if (!transaction) {
      throw new Error(
        `Transaction ${transactionKey} not found or already completed`
      );
    }

    try {
      logger.info(`Rolling back transaction ${transaction.id}: ${reason}`);

      // Delete the transaction (rollback)
      await withRetry(
        () =>
          this.apiClient.delete(
            `/services/haproxy/transactions/${transaction.id}`
          ),
        { retries: this.maxRetries, delay: this.retryDelay }
      );

      // Update transaction
      transaction.status = "rolled-back";
      transaction.endTime = new Date().toISOString();
      transaction.error = reason;

      // Add to history and remove from active
      this.transactionHistory.push(transaction);
      this.activeTransactions.delete(transactionKey);

      // Clear timeout
      this.cleanupTransaction(transactionKey);

      logger.info(`Transaction ${transaction.id} rolled back successfully`);

      // Emit transaction rolled back event
      this.emit("transaction-rolled-back", {
        transaction: { ...transaction },
        reason,
        timestamp: new Date().toISOString(),
      });

      return {
        success: true,
        transaction: { ...transaction },
      };
    } catch (err) {
      logger.error(
        `Failed to rollback transaction ${transaction.id}: ${err.message}`
      );

      // The transaction might be in an inconsistent state now
      // Try to clean up
      this.activeTransactions.delete(transactionKey);
      this.cleanupTransaction(transactionKey);

      throw err;
    }
  }

  /**
   * Handle transaction timeout
   * @param {string} transactionKey - Transaction key
   * @private
   */
  async handleTransactionTimeout(transactionKey) {
    const transaction = this.activeTransactions.get(transactionKey);

    if (!transaction) {
      return;
    }

    logger.warn(
      `Transaction ${transaction.id} timed out after ${this.transactionTimeout}ms`
    );

    try {
      // Rollback the transaction
      await this.rollbackTransaction(transactionKey, "Transaction timed out");
    } catch (err) {
      logger.error(
        `Error during timeout cleanup for transaction ${transaction.id}: ${err.message}`
      );

      // Force cleanup
      this.activeTransactions.delete(transactionKey);
      this.cleanupTransaction(transactionKey);
    }
  }

  /**
   * Clean up transaction resources
   * @param {string} transactionKey - Transaction key
   * @private
   */
  cleanupTransaction(transactionKey) {
    // Clear timeout if exists
    const timeoutId = this.transactionTimeouts.get(transactionKey);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.transactionTimeouts.delete(transactionKey);
    }

    // Release any locks held by this transaction
    for (const [resource, lock] of this.locks.entries()) {
      if (lock.owner === transactionKey) {
        this.locks.delete(resource);
        logger.debug(
          `Released lock for ${resource} held by transaction ${transactionKey}`
        );
      }
    }
  }

  /**
   * Validate HAProxy configuration
   * @param {string} transactionId - HAProxy transaction ID
   * @returns {Promise<Object>} Validation result
   * @private
   */
  async validateConfiguration(transactionId) {
    try {
      // Request configuration validation
      const response = await this.apiClient.get(
        `/services/haproxy/configuration/validate?transaction_id=${transactionId}`
      );

      const result = response.data.data;

      if (result && result.valid) {
        return { valid: true };
      } else {
        return {
          valid: false,
          message:
            result.message ||
            "Configuration validation failed with unknown error",
        };
      }
    } catch (err) {
      logger.error(`Configuration validation failed: ${err.message}`);
      return {
        valid: false,
        message: `Validation error: ${err.message}`,
      };
    }
  }

  /**
   * Record a change in a transaction
   * @param {string} transactionKey - Transaction key
   * @param {Object} change - Change details
   * @returns {boolean} Success status
   */
  recordChange(transactionKey, change) {
    const transaction = this.activeTransactions.get(transactionKey);

    if (!transaction) {
      logger.warn(
        `Cannot record change: transaction ${transactionKey} not found`
      );
      return false;
    }

    // Add change with timestamp
    transaction.changes.push({
      ...change,
      timestamp: new Date().toISOString(),
    });

    return true;
  }

  /**
   * Acquire a lock for a resource in a specific transaction
   * @param {string} transactionKey - Transaction key
   * @param {string} resourceName - Resource name
   * @param {number} timeout - Lock timeout in ms (default: 10000)
   * @returns {Promise<boolean>} Whether lock was acquired
   */
  async acquireLock(transactionKey, resourceName, timeout = 10000) {
    const transaction = this.activeTransactions.get(transactionKey);

    if (!transaction) {
      logger.warn(
        `Cannot acquire lock: transaction ${transactionKey} not found`
      );
      return false;
    }

    // Check if resource is already locked by another transaction
    const existingLock = this.locks.get(resourceName);
    if (existingLock && existingLock.owner !== transactionKey) {
      if (existingLock.expiration > Date.now()) {
        logger.debug(
          `Lock for ${resourceName} already held by ${existingLock.owner}`
        );
        return false;
      }

      // Lock has expired, we can take it
      logger.debug(
        `Taking expired lock for ${resourceName} from ${existingLock.owner}`
      );
    }

    // Create or update lock
    this.locks.set(resourceName, {
      owner: transactionKey,
      resource: resourceName,
      acquired: Date.now(),
      expiration: Date.now() + timeout,
    });

    logger.debug(
      `Acquired lock for ${resourceName} by transaction ${transactionKey}`
    );
    return true;
  }

  /**
   * Release a lock for a resource
   * @param {string} transactionKey - Transaction key
   * @param {string} resourceName - Resource name
   * @returns {boolean} Whether lock was released
   */
  releaseLock(transactionKey, resourceName) {
    const existingLock = this.locks.get(resourceName);

    if (!existingLock) {
      logger.debug(`No lock found for ${resourceName}`);
      return false;
    }

    if (existingLock.owner !== transactionKey) {
      logger.warn(
        `Cannot release lock for ${resourceName}: owned by ${existingLock.owner}, not ${transactionKey}`
      );
      return false;
    }

    this.locks.delete(resourceName);
    logger.debug(
      `Released lock for ${resourceName} by transaction ${transactionKey}`
    );
    return true;
  }

  /**
   * Execute a function within a transaction
   * @param {Function} func - Function to execute with transaction
   * @param {string} description - Optional transaction description
   * @param {Object} metadata - Optional transaction metadata
   * @returns {Promise<Object>} Transaction result
   */
  async withTransaction(func, description = "", metadata = {}) {
    let transaction;
    let transactionKey;

    try {
      // Begin transaction
      transaction = await this.beginTransaction(description, metadata);
      transactionKey = transaction.key;

      // Execute function with transaction
      const result = await func({
        transaction,
        transactionId: transaction.id,
        recordChange: (change) => this.recordChange(transactionKey, change),
        acquireLock: (resource, timeout) =>
          this.acquireLock(transactionKey, resource, timeout),
        releaseLock: (resource) => this.releaseLock(transactionKey, resource),
      });

      // Commit transaction
      await this.commitTransaction(transactionKey);

      return {
        success: true,
        result,
        transaction: { ...transaction },
      };
    } catch (err) {
      logger.error(`Transaction execution failed: ${err.message}`);

      // Rollback if transaction was started
      if (transaction && transactionKey) {
        try {
          await this.rollbackTransaction(
            transactionKey,
            `Execution error: ${err.message}`
          );
        } catch (rollbackErr) {
          logger.error(
            `Additionally failed to rollback: ${rollbackErr.message}`
          );
        }
      }

      return {
        success: false,
        error: err.message,
        transaction: transaction ? { ...transaction } : null,
      };
    }
  }

  /**
   * Get all active transactions
   * @returns {Array} Active transactions
   */
  getActiveTransactions() {
    return Array.from(this.activeTransactions.values());
  }

  /**
   * Get transaction history
   * @param {number} limit - Maximum number of entries (default: 50)
   * @returns {Array} Transaction history
   */
  getTransactionHistory(limit = 50) {
    return this.transactionHistory.slice(-limit);
  }

  /**
   * Get transaction by ID
   * @param {string} id - Transaction ID
   * @returns {Object|null} Transaction or null if not found
   */
  getTransaction(id) {
    // Check active transactions
    for (const transaction of this.activeTransactions.values()) {
      if (transaction.id === id) {
        return { ...transaction };
      }
    }

    // Check transaction history
    for (const transaction of this.transactionHistory) {
      if (transaction.id === id) {
        return { ...transaction };
      }
    }

    return null;
  }

  /**
   * Clean up all resources
   */
  cleanup() {
    // Cancel all timeouts
    for (const [
      transactionKey,
      timeoutId,
    ] of this.transactionTimeouts.entries()) {
      clearTimeout(timeoutId);
    }

    this.transactionTimeouts.clear();

    // Try to rollback all active transactions
    for (const [
      transactionKey,
      transaction,
    ] of this.activeTransactions.entries()) {
      try {
        logger.info(`Cleanup: Rolling back transaction ${transaction.id}`);

        // Use direct API call to avoid tracking
        this.apiClient
          .delete(`/services/haproxy/transactions/${transaction.id}`)
          .catch((err) => {
            logger.error(
              `Failed cleanup rollback for ${transaction.id}: ${err.message}`
            );
          });
      } catch (err) {
        logger.error(
          `Error during cleanup of transaction ${transaction.id}: ${err.message}`
        );
      }
    }

    // Clear all state
    this.activeTransactions.clear();
    this.locks.clear();

    logger.info("Transaction manager cleanup completed");
  }

  /**
   * Create a unique transaction key for tracking
   * @param {string} prefix - Optional prefix
   * @returns {string} Unique key
   * @private
   */
  _createTransactionKey(prefix = "tx") {
    return `${prefix}_${uuidv4()}`;
  }
}

module.exports = HAProxyTransactionManager;
