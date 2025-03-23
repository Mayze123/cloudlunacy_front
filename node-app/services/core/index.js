/**
 * Core Services Index
 *
 * Exports all core services and handles initialization.
 * Uses the new improved implementations for certificate handling and routing.
 */

const logger = require("../../utils/logger").getLogger("coreServices");
const configService = require("./configManager");
const agentService = require("./agentService");

// Import the new services
const CertificateManager = require("./certificateManager");
const RoutingService = require("./routingService");
const HAProxyManager = require("./haproxyConfigManager");
const LetsEncryptManager = require("./letsencryptManager");
const mongodbService = require("./mongodbService");

// Create instances
const haproxyService = new HAProxyManager();
const certificateService = new CertificateManager(configService);
const routingService = new RoutingService();
const letsencryptService = new LetsEncryptManager(configService);

const coreServices = {
  configService,
  agentService,
  routingService,
  certificateService,
  haproxyService,
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

      // Initialize HAProxy service
      const haproxyInitialized = await haproxyService.initialize();
      if (!haproxyInitialized) {
        logger.error("Failed to initialize HAProxy service");
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

      // Initialize agent service
      const agentInitialized = await agentService.initialize();
      if (!agentInitialized) {
        logger.error("Failed to initialize agent service");
        return false;
      }

      // Initialize MongoDB service
      const mongoInitialized = await mongodbService.initialize();
      if (!mongoInitialized) {
        logger.error("Failed to initialize MongoDB service");
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
