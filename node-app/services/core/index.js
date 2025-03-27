/**
 * Core Services Module
 *
 * This module acts as the central hub for all core services:
 * - ConfigService: Configuration management
 * - RoutingService: HAProxy route management
 * - MongoDB and Redis database services
 * - Certificate management
 */

const logger = require("../../utils/logger").getLogger("coreServices");
const ConfigService = require("./configService");
const RoutingService = require("./routingService");
const CertificateService = require("./certificateService");
const DatabaseFactory = require("./databases/databaseFactory");
const HAProxyManager = require("./haproxyManager");
const HAProxyConfigManager = require("./haproxyConfigManager");
const AgentService = require("./agentService");

// Create instances of all services
const configService = new ConfigService();
const routingService = new RoutingService();
const certificateService = new CertificateService(configService);
const haproxyConfigManager = new HAProxyConfigManager();
const haproxyManager = new HAProxyManager(haproxyConfigManager);

// Initialize database factory with routing service and HAProxy manager
// This avoids circular dependency issues
const databaseFactory = new DatabaseFactory(routingService, haproxyManager);

// Get MongoDB service instance
const mongodbService = databaseFactory.getService("mongodb");

// Create agent service with config service and MongoDB service
const agentService = new AgentService(configService, mongodbService);

// Export all service instances and utilities
module.exports = {
  // Core services
  configService,
  routingService,
  certificateService,
  haproxyConfigManager,
  haproxyManager,
  agentService,

  // Database services
  databaseFactory,
  mongodbService,
  redisService: databaseFactory.getService("redis"),

  // Convenience helpers for backward compatibility
  getConfigService: () => configService,
  getRoutingService: () => routingService,
  getCertificateService: () => certificateService,
  getDatabaseService: (type) => databaseFactory.getService(type),

  /**
   * Initialize all core services
   * @returns {Promise<boolean>} Success status
   */
  initialize: async function () {
    try {
      logger.info("Initializing core services");

      // Initialize config service first
      const configInitialized = await configService.initialize();
      if (!configInitialized) {
        logger.error("Failed to initialize config service");
        return false;
      }

      // Initialize HAProxy config manager
      const haproxyConfigInitialized = await haproxyConfigManager.initialize();
      if (!haproxyConfigInitialized) {
        logger.error("Failed to initialize HAProxy config manager");
        // Continue anyway as this is not critical
        logger.warn("Continuing without HAProxy config manager");
      }

      // Initialize routing service
      const routingInitialized = await routingService.initialize();
      if (!routingInitialized) {
        logger.error("Failed to initialize routing service");
        return false;
      }

      // Initialize HAProxy manager
      const haproxyInitialized = await haproxyManager.initialize();
      if (!haproxyInitialized) {
        logger.error("Failed to initialize HAProxy manager");
        return false;
      }

      // Initialize certificate service
      const certInitialized = await certificateService.initialize();
      if (!certInitialized) {
        logger.error("Failed to initialize certificate service");
        return false;
      }

      // Initialize database services via the factory
      const dbInitialized = await databaseFactory.initialize();
      if (!dbInitialized) {
        logger.error("Failed to initialize database services");
        return false;
      }

      // Initialize agent service
      const agentInitialized = await agentService.initialize();
      if (!agentInitialized) {
        logger.error("Failed to initialize agent service");
        return false;
      }

      logger.info("All core services initialized successfully");
      return true;
    } catch (error) {
      logger.error(`Error initializing core services: ${error.message}`, {
        error: error.message,
        stack: error.stack,
      });
      return false;
    }
  },
};
