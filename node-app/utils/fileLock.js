/**
 * FileLock Utility
 *
 * Provides file-based locking mechanism for critical operations
 * - Prevents concurrent operations from clashing
 * - Supports timeouts to prevent deadlocks
 * - Automatic cleanup of stale locks
 */

const fs = require("fs").promises;
const path = require("path");
const os = require("os");
const logger = require("./logger").getLogger("fileLock");

// Default values
const LOCKS_DIR =
  process.env.LOCKS_DIR || path.join(os.tmpdir(), "cloudlunacy_locks");
const DEFAULT_TIMEOUT = 30000; // 30 seconds
const DEFAULT_STALE_THRESHOLD = 5 * 60 * 1000; // 5 minutes

/**
 * File Lock class for controlling concurrent access to resources
 */
class FileLock {
  /**
   * Create a new file lock instance
   * @param {string} lockId - Unique identifier for this lock
   * @param {string} lockPath - Path to the lock file
   * @param {number} acquiredAt - Timestamp when lock was acquired
   */
  constructor(lockId, lockPath, acquiredAt) {
    this.lockId = lockId;
    this.lockPath = lockPath;
    this.acquiredAt = acquiredAt;
    this.released = false;
  }

  /**
   * Release the lock
   * @returns {Promise<boolean>} Success status
   */
  async release() {
    if (this.released) {
      return true;
    }

    try {
      await fs.unlink(this.lockPath);
      this.released = true;
      logger.debug(`Lock ${this.lockId} released`);
      return true;
    } catch (err) {
      logger.error(`Failed to release lock ${this.lockId}: ${err.message}`);
      return false;
    }
  }

  /**
   * Get information about the lock
   * @returns {Object} Lock details
   */
  getInfo() {
    return {
      id: this.lockId,
      path: this.lockPath,
      acquiredAt: new Date(this.acquiredAt).toISOString(),
      released: this.released,
      age: Date.now() - this.acquiredAt,
    };
  }

  /**
   * Acquire a lock with timeout
   * @param {string} lockId - Unique identifier for the lock
   * @param {number} timeout - Maximum time to wait for lock acquisition in ms
   * @returns {Promise<Object>} Lock result with success status and lock object
   * @static
   */
  static async acquire(lockId, timeout = DEFAULT_TIMEOUT) {
    // Ensure locks directory exists
    await fs.mkdir(LOCKS_DIR, { recursive: true });

    const lockPath = path.join(
      LOCKS_DIR,
      `${lockId.replace(/[^a-z0-9-_]/gi, "_")}.lock`
    );
    const start = Date.now();

    // Try to acquire the lock
    while (Date.now() - start < timeout) {
      try {
        // Check if there's a stale lock
        await FileLock.cleanupStaleLock(lockPath);

        // Try to create lock file exclusively
        await fs.writeFile(lockPath, String(process.pid), {
          flag: "wx", // wx = create file exclusively, fail if exists
        });

        logger.debug(`Lock ${lockId} acquired`);

        // Return successful acquisition
        const lock = new FileLock(lockId, lockPath, Date.now());
        return {
          success: true,
          lock,
        };
      } catch (err) {
        // If file exists, lock is already held
        if (err.code === "EEXIST") {
          // Wait a bit before retrying
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }

        // For other errors, fail acquisition
        logger.error(`Failed to acquire lock ${lockId}: ${err.message}`);
        return {
          success: false,
          error: err.message,
        };
      }
    }

    // Timeout reached
    logger.warn(`Lock acquisition timeout for ${lockId} after ${timeout}ms`);
    return {
      success: false,
      error: `Timeout acquiring lock after ${timeout}ms`,
    };
  }

  /**
   * Check if a lock file is stale and remove it if necessary
   * @param {string} lockPath - Path to the lock file
   * @returns {Promise<boolean>} Whether lock was cleaned up
   * @private
   * @static
   */
  static async cleanupStaleLock(lockPath) {
    try {
      // Check if lock file exists
      const stats = await fs.stat(lockPath);
      const lockAge = Date.now() - stats.mtime.getTime();

      // If lock is older than threshold, it's considered stale
      if (lockAge > DEFAULT_STALE_THRESHOLD) {
        try {
          await fs.unlink(lockPath);
          logger.warn(
            `Removed stale lock file: ${lockPath} (age: ${lockAge}ms)`
          );
          return true;
        } catch (err) {
          // File may have been removed by another process
          if (err.code !== "ENOENT") {
            logger.error(`Failed to remove stale lock: ${err.message}`);
          }
        }
      }
    } catch (err) {
      // File doesn't exist, no cleanup needed
      if (err.code !== "ENOENT") {
        logger.error(`Error checking lock file: ${err.message}`);
      }
    }

    return false;
  }

  /**
   * Clean up all stale locks in the locks directory
   * @returns {Promise<number>} Number of locks cleaned up
   * @static
   */
  static async cleanupStaleLocks() {
    try {
      // Ensure locks directory exists
      await fs.mkdir(LOCKS_DIR, { recursive: true });

      // Get all lock files
      const files = await fs.readdir(LOCKS_DIR);
      let cleanedCount = 0;

      // Check each file
      for (const file of files) {
        if (file.endsWith(".lock")) {
          const lockPath = path.join(LOCKS_DIR, file);
          const wasRemoved = await FileLock.cleanupStaleLock(lockPath);
          if (wasRemoved) {
            cleanedCount++;
          }
        }
      }

      if (cleanedCount > 0) {
        logger.info(`Cleaned up ${cleanedCount} stale locks`);
      }

      return cleanedCount;
    } catch (err) {
      logger.error(`Error cleaning up stale locks: ${err.message}`);
      return 0;
    }
  }
}

module.exports = FileLock;
