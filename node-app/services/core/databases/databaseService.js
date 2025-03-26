/**
 * Database Service Base Class
 *
 * Abstract base class that all database service implementations must extend.
 * Provides common database functionality and interface requirements.
 */

class DatabaseService {
  constructor(routingService) {
    this.routingService = routingService;
    this.initialized = false;

    // Ensure the class is not instantiated directly
    if (this.constructor === DatabaseService) {
      throw new Error(
        "DatabaseService is an abstract class and cannot be instantiated directly"
      );
    }
  }

  /**
   * Initialize the database service
   * Must be implemented by subclasses
   */
  async initialize() {
    throw new Error("initialize() method must be implemented by subclass");
  }

  /**
   * Register an agent for this database
   * Must be implemented by subclasses
   */
  async registerAgent(_agentId, _targetIp, _options) {
    throw new Error("registerAgent() method must be implemented by subclass");
  }

  /**
   * Deregister an agent from this database
   * Must be implemented by subclasses
   */
  async deregisterAgent(_agentId) {
    throw new Error("deregisterAgent() method must be implemented by subclass");
  }

  /**
   * Test connection to the database
   * Must be implemented by subclasses
   */
  async testConnection(_agentId, _targetIp) {
    throw new Error("testConnection() method must be implemented by subclass");
  }

  /**
   * Get connection information for the database
   * Must be implemented by subclasses
   */
  async getConnectionInfo(_agentId) {
    throw new Error(
      "getConnectionInfo() method must be implemented by subclass"
    );
  }

  /**
   * Generate credentials for database access
   * May be implemented by subclasses if applicable
   */
  async generateCredentials(_agentId, _dbName, _username) {
    throw new Error(
      "generateCredentials() method must be implemented by subclass"
    );
  }
}

module.exports = DatabaseService;
