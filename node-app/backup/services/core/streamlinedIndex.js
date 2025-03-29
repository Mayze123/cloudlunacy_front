/**
 * Streamlined Core Services Module
 *
 * A simplified and consolidated version of the core services using the new architecture.
 * Focuses on the primary goal of proxying traffic to agent VPSs using subdomains.
 */

const logger = require("../../utils/logger").getLogger("coreServices");
const ProxyService = require("./proxyService");
const AgentService = require("./agentService");
const ConfigService = require("./configService");
const HAProxyService = require("./haproxyService");

// Create instances of core services
const haproxyService = new HAProxyService();
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

      // 2. Initialize HAProxy service
      const haproxyInitialized = await haproxyService.initialize();
      if (!haproxyInitialized) {
        logger.error("Failed to initialize HAProxy service");
        return false;
      }

      // 3. Initialize proxy service
      const proxyInitialized = await proxyService.initialize();
      if (!proxyInitialized) {
        logger.error("Failed to initialize proxy service");
        return false;
      }

      // 4. Initialize agent service
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
