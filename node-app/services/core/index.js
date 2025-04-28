/**
 * Core Services Module
 *
 * Consolidated version of the core services using Consul for configuration storage and proxying.
 * Focuses on the primary goal of proxying traffic to agent VPSs using subdomains.
 */

const logger = require("../../utils/logger").getLogger("coreServices");
const ProxyService = require("./proxyService");
const AgentService = require("./agentService");
const ConfigService = require("./configService");
const CertificateService = require("./certificateService");
const CertificateRenewalService = require("./certificateRenewalService");
const CertificateMetricsService = require("./certificateMetricsService");
const MongoDBService = require("./databases/mongodbService");
const ConsulService = require("./consulService");

// Create instances of core services
const certificateService = new CertificateService();
const proxyService = new ProxyService();
// Initialize MongoDB service with proxy dependency
const mongodbService = new MongoDBService(proxyService);
const configService = new ConfigService();
const certificateRenewalService = new CertificateRenewalService(
  certificateService
);
const certificateMetricsService = new CertificateMetricsService(
  certificateService
);

// Initialize agent service with dependencies
const agentService = new AgentService(configService);

// Initialize Consul service
const consulService = new ConsulService();

// Export all service instances
module.exports = {
  // Primary services
  proxyService,
  agentService,
  configService,
  mongodbService,
  certificateService,
  certificateRenewalService,
  certificateMetricsService,
  consulService,

  /**
   * Get the Consul service instance
   * @returns {ConsulService} Consul service
   */
  getConsulService: function () {
    return consulService;
  },

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

      // 3. Initialize Consul service for KV store
      try {
        const consulInitialized = await consulService.initialize();
        if (!consulInitialized) {
          logger.warn(
            "Consul service initialization had issues but will continue with limited functionality"
          );
          // Continue anyway - don't return false
        } else {
          logger.info("Consul service initialized successfully");
        }
      } catch (consulError) {
        logger.warn(
          `Consul service initialization error: ${consulError.message}. Continuing with limited functionality.`
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

      // 6. Initialize certificate renewal service
      try {
        const renewalInitialized = await certificateRenewalService.initialize();
        if (!renewalInitialized) {
          logger.warn(
            "Certificate renewal service initialization had issues but will continue"
          );
          // Continue anyway - don't return false
        } else {
          logger.info("Certificate renewal service initialized successfully");
        }
      } catch (renewalError) {
        logger.warn(
          `Certificate renewal service initialization error: ${renewalError.message}. Continuing without automatic renewal.`
        );
        // Continue anyway - don't return false
      }

      // 7. Take initial metrics snapshot
      try {
        await certificateMetricsService.takeMetricsSnapshot();
        logger.info("Initial certificate metrics snapshot taken");
      } catch (metricsError) {
        logger.warn(
          `Failed to take initial metrics snapshot: ${metricsError.message}. Continuing without initial metrics.`
        );
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
