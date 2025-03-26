/**
 * Database Factory
 *
 * Manages the creation and access of database service instances.
 * Supports different database types (MongoDB, Redis, etc.) through a unified interface.
 */

const logger = require("../../../utils/logger").getLogger("databaseFactory");
const path = require("path");
const fs = require("fs");

class DatabaseFactory {
  constructor(routingService, haproxyManager) {
    this.routingService = routingService;
    this.haproxyManager = haproxyManager;
    this.serviceInstances = new Map();
    this.initialized = false;
  }

  /**
   * Initialize the database factory and all available database services
   */
  async initialize() {
    if (this.initialized) {
      return true;
    }

    try {
      logger.info("Initializing database factory");

      // Get available database services
      const servicesDir = path.join(__dirname);
      const files = fs.readdirSync(servicesDir);

      // Load service modules dynamically
      const serviceFiles = files.filter(
        (file) =>
          file.endsWith("Service.js") && !file.includes("databaseService")
      );

      logger.info(`Found ${serviceFiles.length} database service modules`);

      // Initialize each service
      for (const file of serviceFiles) {
        try {
          // Extract database type from filename (e.g., mongodbService.js -> mongodb)
          const dbType = file.replace("Service.js", "").toLowerCase();

          // Skip if already loaded
          if (this.serviceInstances.has(dbType)) {
            continue;
          }

          // Load the service class
          const ServiceClass = require(path.join(servicesDir, file));

          // Instantiate and initialize the service with both routing service and haproxy manager
          const serviceInstance = new ServiceClass(
            this.routingService,
            this.haproxyManager
          );
          await serviceInstance.initialize();

          // Store the instance
          this.serviceInstances.set(dbType, serviceInstance);
          logger.info(`Initialized ${dbType} database service`);
        } catch (error) {
          logger.error(
            `Failed to initialize database service from ${file}: ${error.message}`,
            {
              error: error.message,
              stack: error.stack,
            }
          );
          // Continue with other services
        }
      }

      this.initialized = true;

      // Ensure MongoDB service is available since it's a core service
      if (!this.serviceInstances.has("mongodb")) {
        logger.warn("MongoDB service not found or failed to initialize");
      }

      logger.info(
        `Database factory initialized with ${this.serviceInstances.size} services`
      );
      return true;
    } catch (error) {
      logger.error(`Failed to initialize database factory: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });
      return false;
    }
  }

  /**
   * Get a database service instance by type
   * @param {string} type - Database type (mongodb, redis, etc.)
   * @returns {Object} Database service instance or null if not found
   */
  getService(type) {
    if (!type) {
      logger.error("Database type is required");
      return null;
    }

    const dbType = type.toLowerCase();

    // Check if service exists
    if (!this.serviceInstances.has(dbType)) {
      // Lazy-load service if not initialized yet
      try {
        const ServiceClass = require(`./${dbType}Service.js`);
        const serviceInstance = new ServiceClass(
          this.routingService,
          this.haproxyManager
        );
        this.serviceInstances.set(dbType, serviceInstance);

        // Schedule async initialization
        serviceInstance.initialize().catch((error) => {
          logger.error(
            `Failed to initialize ${dbType} service: ${error.message}`
          );
        });

        logger.info(`Lazy-loaded ${dbType} database service`);
      } catch (error) {
        logger.error(
          `Database service '${dbType}' not available: ${error.message}`
        );
        return null;
      }
    }

    return this.serviceInstances.get(dbType) || null;
  }

  /**
   * Get all available database services
   * @returns {Array} Array of available database types
   */
  getAvailableServices() {
    return Array.from(this.serviceInstances.keys());
  }
}

module.exports = DatabaseFactory;
