/**
 * Core Services Index
 *
 * Exports all core services and handles initialization.
 * Uses the new improved implementations for certificate handling and routing.
 */

const logger = require("../../utils/logger").getLogger("coreServices");
const ConfigManager = require("./configManager");
const configService = new ConfigManager(); // Create an instance of the ConfigManager
const AgentService = require("./agentService"); // Import the AgentService class
const MongoDBService = require("./mongodbService");

// Import the new services
const CertificateManager = require("./certificateManager");
const RoutingService = require("./routingService");
const HAProxyConfigManager = require("./haproxyConfigManager");
const HAProxyManager = require("./haproxyManager");
const LetsEncryptManager = require("./letsencryptManager");

// Create instances
const haproxyConfigService = new HAProxyConfigManager();
const haproxyManager = new HAProxyManager(configService);
const certificateService = new CertificateManager(configService);
const routingService = new RoutingService();
const letsencryptService = new LetsEncryptManager(configService);
// Create instance of MongoDBService with dependencies
const mongodbService = new MongoDBService(configService, routingService);
// Create an instance of AgentService with dependencies
const agentService = new AgentService(configService, mongodbService);

const coreServices = {
  configService,
  agentService,
  routingService,
  certificateService,
  haproxyService: haproxyConfigService, // For backward compatibility
  haproxyManager: haproxyManager, // New service for MongoDB operations
  haproxyConfigService, // Explicit name
  letsencryptService,
  mongodbService,

  /**
   * Initialize all core services
   */
  async initialize() {
    try {
      logger.info("Initializing core services");

      // Initialize config service first
      await configService.initialize();

      // Initialize certificate service
      const certInitialized = await certificateService.initialize();
      if (!certInitialized) {
        logger.error("Failed to initialize certificate service");
        return false;
      }

      // Initialize HAProxy config service
      const haproxyConfigInitialized = await haproxyConfigService.initialize();
      if (!haproxyConfigInitialized) {
        logger.error("Failed to initialize HAProxy config service");
        return false;
      }

      // Initialize HAProxy manager service
      const haproxyManagerInitialized = await haproxyManager.initialize();
      if (!haproxyManagerInitialized) {
        logger.error("Failed to initialize HAProxy manager service");
        return false;
      }

      // Initialize routing service
      const routingInitialized = await routingService.initialize();
      if (!routingInitialized) {
        logger.error("Failed to initialize routing service");
        return false;
      }

      // Initialize Let's Encrypt service
      const letsencryptInitialized = await letsencryptService.initialize();
      if (!letsencryptInitialized) {
        logger.warn(
          "Failed to initialize Let's Encrypt service, continuing without it"
        );
        // Not critical for system operation, so continue
      } else {
        // Set up automated renewal checks
        letsencryptService.setupAutoRenewal(24); // Check every 24 hours
      }

      // Initialize MongoDB service first before agent service since agent service depends on it
      // Pass the haproxyService instance to avoid circular dependencies
      const mongoInitialized = await mongodbService.initialize(
        haproxyConfigService
      );
      if (!mongoInitialized) {
        logger.error("Failed to initialize MongoDB service");
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
    } catch (err) {
      logger.error(`Failed to initialize core services: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return false;
    }
  },

  /**
   * Shutdown all core services
   */
  async shutdown() {
    try {
      logger.info("Shutting down core services");

      // Add any cleanup needed for services

      logger.info("Core services shutdown complete");
      return true;
    } catch (err) {
      logger.error(`Error during core services shutdown: ${err.message}`);
      return false;
    }
  },
};

module.exports = coreServices;
