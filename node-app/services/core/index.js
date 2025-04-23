/**
 * Core Services Module
 *
 * Consolidated version of the core services using Traefik for proxying.
 * Focuses on the primary goal of proxying traffic to agent VPSs using subdomains.
 */

const logger = require("../../utils/logger").getLogger("coreServices");
const ProxyService = require("./proxyService");
const AgentService = require("./agentService");
const ConfigService = require("./configService");
const TraefikService = require("./traefikService");
const CertificateService = require("./certificateService");
const CertificateRenewalService = require("./certificateRenewalService");
const CertificateMetricsService = require("./certificateMetricsService");
const MongoDBService = require("./databases/mongodbService");

// Create instances of core services
const certificateService = new CertificateService();

// Create Traefik service
const traefikService = new TraefikService(certificateService);

const proxyService = new ProxyService();
// Initialize MongoDB service with proxy and Traefik dependencies
const mongodbService = new MongoDBService(proxyService, traefikService);
const configService = new ConfigService();
const certificateRenewalService = new CertificateRenewalService(
  certificateService
);
const certificateMetricsService = new CertificateMetricsService(
  certificateService
);

// Initialize agent service with dependencies
const agentService = new AgentService(configService);

// Export all service instances
module.exports = {
  // Primary services
  proxyService,
  agentService,
  configService,
  mongodbService,
  traefikService,
  certificateService,
  certificateRenewalService,
  certificateMetricsService,

  /**
   * Get the Traefik service instance
   * @returns {TraefikService} Traefik service
   */
  getTraefikService: function () {
    return traefikService;
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

      // 3. Initialize Traefik service - continue even if it fails
      try {
        const traefikInitialized = await traefikService.initialize();
        if (!traefikInitialized) {
          logger.warn(
            "Traefik service initialization had issues but will continue with limited functionality"
          );
          // Continue anyway - don't return false
        } else {
          logger.info("Traefik service initialized successfully");
        }
      } catch (traefikError) {
        logger.warn(
          `Traefik service initialization error: ${traefikError.message}. Continuing with limited functionality.`
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
