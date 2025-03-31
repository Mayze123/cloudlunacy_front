/**
 * Core Services Module
 *
 * Consolidated version of the core services using the HAProxy Data Plane API.
 * Focuses on the primary goal of proxying traffic to agent VPSs using subdomains.
 */

const logger = require("../../utils/logger").getLogger("coreServices");
const ProxyService = require("./proxyService");
const AgentService = require("./agentService");
const ConfigService = require("./configService");
const HAProxyService = require("./haproxyService");
const CertificateService = require("./certificateService");

// Create instances of core services
const certificateService = new CertificateService();
const haproxyService = new HAProxyService(certificateService);
const proxyService = new ProxyService();
const configService = new ConfigService();

// Initialize agent service with dependencies
const agentService = new AgentService(configService);

// Export all service instances
module.exports = {
  // Primary services
  proxyService,
  agentService,
  configService,
  haproxyService,
  certificateService,

  /**
   * Initialize all core services
   * @returns {Promise<boolean>} Success status
   */
  initialize: async function () {
    try {
      logger.info("Initializing core services");

      // Initialize services in order of dependencies
      // 1. First config service as others may depend on it
      const configInitialized = await configService.initialize();
      if (!configInitialized) {
        logger.error("Failed to initialize config service");
        return false;
      }

      // 2. Initialize certificate service for SSL/TLS
      const certificateInitialized = await certificateService.initialize();
      if (!certificateInitialized) {
        logger.error("Failed to initialize certificate service");
        return false;
      }

      // 3. Initialize HAProxy service - continue even if it fails
      try {
        const haproxyInitialized = await haproxyService.initialize();
        if (!haproxyInitialized) {
          logger.warn(
            "HAProxy service initialization had issues but will continue with limited functionality"
          );
          // Continue anyway - don't return false
        }
      } catch (haproxyError) {
        logger.warn(
          `HAProxy service initialization error: ${haproxyError.message}. Continuing with limited functionality.`
        );
        // Continue anyway - don't return false
      }

      // 4. Initialize proxy service
      const proxyInitialized = await proxyService.initialize();
      if (!proxyInitialized) {
        logger.error("Failed to initialize proxy service");
        return false;
      }

      // 5. Initialize agent service
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
