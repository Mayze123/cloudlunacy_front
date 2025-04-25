/**
 * Traefik Service
 *
 * Provides a service layer for interacting with Traefik v2 for routing and load balancing.
 * Replaces the previous HAProxy service with a more modern and cloud-native approach.
 */

const fs = require("fs").promises;
const path = require("path");
const yaml = require("js-yaml");
const axios = require("axios");
const { promisify } = require("util");
const exec = promisify(require("child_process").exec);
const logger = require("../../utils/logger").getLogger("traefikService");
const { AppError } = require("../../utils/errorHandler");
const { withRetry } = require("../../utils/retryHandler");

class TraefikService {
  constructor(certificateService) {
    this.initialized = false;
    this.certificateService = certificateService;
    this.traefikContainer = process.env.TRAEFIK_CONTAINER || "traefik";

    // Determine the correct configuration path based on environment
    const isProduction = process.env.NODE_ENV === "production";

    // In production, use a path inside the container that the node user can write to
    const defaultConfigPath = isProduction
      ? "/app/config/traefik"
      : "/app/config/traefik";

    // Use environment variable if set, otherwise use default
    this.configPath = process.env.TRAEFIK_CONFIG_PATH || defaultConfigPath;
    this.dynamicConfigPath = path.join(this.configPath, "dynamic");
    this.routesConfigPath = path.join(this.dynamicConfigPath, "routes.yml");

    // Log the configuration paths during initialization
    logger.debug(`Traefik configuration paths:`, {
      configPath: this.configPath,
      dynamicConfigPath: this.dynamicConfigPath,
      routesConfigPath: this.routesConfigPath,
    });

    this.mongoDomain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
    this.appDomain = process.env.APP_DOMAIN || "apps.cloudlunacy.uk";
    this.healthStatus = {
      status: "unknown",
      lastCheck: null,
      details: {},
    };
    this.routes = {
      http: {},
      mongodb: {},
    };
  }

  /**
   * Initialize the Traefik service
   * @returns {Promise<boolean>} Success flag
   */
  async initialize() {
    try {
      if (this.initialized) {
        return true;
      }

      logger.info("Initializing Traefik service");

      // Check if Traefik is running
      const containerStatus = await this.checkTraefikContainer();
      if (!containerStatus.running) {
        logger.warn(
          `Traefik container is not running: ${
            containerStatus.error || "unknown error"
          }`
        );
      }

      // Load existing routes if available
      try {
        await this.loadRoutes();
        logger.info("Loaded existing routes from configuration");
      } catch (err) {
        if (err.code === "ENOENT") {
          logger.info(
            "No existing routes configuration found, will create when needed"
          );
        } else {
          logger.warn(`Error loading existing routes: ${err.message}`);
        }

        // Initialize empty routes structure
        await this.saveRoutes();
      }

      // Initial health check
      await this.performHealthCheck();

      this.initialized = true;
      logger.info("Traefik service initialized successfully");
      return true;
    } catch (err) {
      logger.error(`Failed to initialize Traefik service: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return false;
    }
  }

  /**
   * Load routes from Traefik configuration
   * @returns {Promise<Object>} Routes object
   */
  async loadRoutes() {
    try {
      const routesYaml = await fs.readFile(this.routesConfigPath, "utf8");
      const config = yaml.load(routesYaml) || {};

      // Initialize default structure if missing
      if (!config.http) config.http = {};
      if (!config.http.routers) config.http.routers = {};
      if (!config.http.services) config.http.services = {};
      if (!config.tcp) config.tcp = {};
      if (!config.tcp.routers) config.tcp.routers = {};
      if (!config.tcp.services) config.tcp.services = {};

      // Extract routes from configuration
      this.routes = {
        http: {},
        mongodb: {},
      };

      // Process HTTP routes
      Object.entries(config.http.routers).forEach(([name, router]) => {
        if (name.startsWith("agent-")) {
          const agentId = name.replace("agent-", "");
          const subdomain = router.rule
            .match(/Host\(`([^`]+)`\)/)[1]
            .split(".")[0];

          this.routes.http[`${agentId}-${subdomain}`] = {
            agentId,
            subdomain,
            router: name,
            service: router.service,
            rule: router.rule,
          };
        }
      });

      // Process MongoDB routes
      Object.entries(config.tcp.routers).forEach(([name, router]) => {
        if (name.startsWith("mongodb-")) {
          const agentId = name.replace("mongodb-", "");
          const serviceName = router.service;

          // Extract the targetHost and targetPort from the service configuration
          let targetHost = "127.0.0.1";
          let targetPort = 27017;

          if (
            config.tcp.services &&
            config.tcp.services[serviceName] &&
            config.tcp.services[serviceName].loadBalancer &&
            config.tcp.services[serviceName].loadBalancer.servers &&
            config.tcp.services[serviceName].loadBalancer.servers.length > 0
          ) {
            const addressParts =
              config.tcp.services[
                serviceName
              ].loadBalancer.servers[0].address.split(":");
            if (addressParts.length === 2) {
              targetHost = addressParts[0];
              targetPort = parseInt(addressParts[1], 10);
            }
          }

          this.routes.mongodb[agentId] = {
            agentId,
            router: name,
            service: serviceName,
            rule: router.rule,
            targetHost,
            targetPort,
          };

          logger.debug(`Loaded MongoDB route for ${agentId}`, {
            targetHost,
            targetPort,
            routerName: name,
            serviceName,
          });
        }
      });

      return this.routes;
    } catch (err) {
      logger.error(`Failed to load routes: ${err.message}`);
      throw err;
    }
  }

  /**
   * Save routes to Traefik configuration file
   * @returns {Promise<boolean>} Success flag
   */
  async saveRoutes() {
    try {
      // Create config structure
      const config = {
        http: {
          routers: {
            "traefik-healthcheck": {
              entryPoints: ["traefik"],
              rule: "Path(`/ping`)",
              service: "api@internal",
            },
          },
          services: {
            "dummy-service": {
              loadBalancer: {
                servers: [{ url: "http://localhost:3005" }],
              },
            },
          },
        },
        tcp: {
          routers: {},
          services: {},
        },
      };

      // Add HTTP routes
      Object.values(this.routes.http).forEach((route) => {
        const routerName = `agent-${route.agentId}-${route.subdomain}`;
        const serviceName = `service-${route.agentId}-${route.subdomain}`;

        config.http.routers[routerName] = {
          rule: `Host(\`${route.subdomain}.${this.appDomain}\`)`,
          service: serviceName,
          entryPoints: ["websecure"],
          tls: {},
        };

        config.http.services[serviceName] = {
          loadBalancer: {
            servers: [{ url: route.targetUrl }],
          },
        };
      });

      // Add MongoDB routes
      Object.values(this.routes.mongodb).forEach((route) => {
        const routerName = `mongodb-${route.agentId}`;
        const serviceName = `mongodb-service-${route.agentId}`;

        config.tcp.routers[routerName] = {
          rule: `HostSNI(\`${route.agentId}.${this.mongoDomain}\`)`,
          service: serviceName,
          entryPoints: ["mongodb"],
          tls: {
            passthrough: true,
          },
        };

        // Add better debug logging to trace the issue
        logger.debug(`Creating MongoDB route for ${route.agentId}`, {
          targetHost: route.targetHost,
          targetPort: route.targetPort,
          routerName,
          serviceName,
        });

        // Ensure we're using the targetHost and targetPort from the route
        // and that they are not undefined, defaulting to 127.0.0.1:27017 only if missing
        const targetHost = route.targetHost || "127.0.0.1";
        const targetPort = route.targetPort || 27017;

        config.tcp.services[serviceName] = {
          loadBalancer: {
            servers: [{ address: `${targetHost}:${targetPort}` }],
          },
        };
      });

      // Generate the YAML content
      const yamlStr =
        "# Dynamic routes configuration for Traefik\n" +
        "# This file is managed by the CloudLunacy Front API\n\n" +
        yaml.dump(config);

      // Save the configuration using multiple fallback methods to ensure it works in all environments
      return await this._saveRoutesWithFallback(yamlStr);
    } catch (err) {
      logger.error(`Failed to save routes: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      return false;
    }
  }

  /**
   * Save routes using multiple fallback mechanisms to handle permission issues
   * @param {string} yamlContent - The YAML content to save
   * @returns {Promise<boolean>} Success flag
   * @private
   */
  async _saveRoutesWithFallback(yamlContent) {
    // First try: Direct file write using fs.promises
    try {
      // Create directory if it doesn't exist
      await fs.mkdir(this.dynamicConfigPath, { recursive: true });
      await fs.writeFile(this.routesConfigPath, yamlContent);
      logger.info("Routes configuration saved successfully via direct write");
      return true;
    } catch (directWriteErr) {
      logger.warn(
        `Direct file write failed: ${directWriteErr.message}, trying fallback methods`,
        {
          error: directWriteErr.message,
          code: directWriteErr.code,
          path: this.routesConfigPath,
        }
      );

      // Second try: Use Docker exec to write the file with proper permissions
      try {
        // Create a temporary file in /tmp which should be writable
        const tempFilePath = `/tmp/traefik-routes-${Date.now()}.yml`;
        await fs.writeFile(tempFilePath, yamlContent);

        // Use docker cp to copy the file into the container
        const { stdout, stderr } = await exec(
          `docker cp ${tempFilePath} ${this.traefikContainer}:${this.routesConfigPath}`
        );

        // Clean up temp file
        await fs
          .unlink(tempFilePath)
          .catch((e) => logger.debug(`Temp file cleanup failed: ${e.message}`));

        logger.info("Routes configuration saved successfully via docker cp");

        // Reload Traefik to apply the configuration
        await this._reloadTraefikConfig();

        return true;
      } catch (dockerErr) {
        logger.warn(`Docker file write failed: ${dockerErr.message}`, {
          error: dockerErr.message,
          stderr: dockerErr.stderr,
        });

        // Final attempt: Use shell script through Docker to write file
        try {
          const escapedContent = yamlContent.replace(/'/g, "'\\''");
          const dockerCmd = `docker exec ${
            this.traefikContainer
          } /bin/sh -c 'mkdir -p ${path.dirname(
            this.routesConfigPath
          )} && echo '${escapedContent}' > ${this.routesConfigPath}'`;

          await exec(dockerCmd);
          logger.info(
            "Routes configuration saved successfully via docker exec shell"
          );

          // Reload Traefik to apply the configuration
          await this._reloadTraefikConfig();

          return true;
        } catch (shellErr) {
          logger.error(`All file write methods failed: ${shellErr.message}`, {
            directError: directWriteErr.message,
            dockerError: dockerErr.message,
            shellError: shellErr.message,
          });
          return false;
        }
      }
    }
  }

  /**
   * Reload the Traefik configuration
   * @returns {Promise<boolean>} Success flag
   * @private
   */
  async _reloadTraefikConfig() {
    try {
      // Send SIGHUP to Traefik process (standard reload signal)
      await exec(`docker kill --signal=SIGHUP ${this.traefikContainer}`);
      logger.info("Sent reload signal to Traefik");
      return true;
    } catch (err) {
      logger.warn(`Failed to reload Traefik configuration: ${err.message}`, {
        error: err.message,
      });
      return false;
    }
  }

  /**
   * Add HTTP route for an agent
   * @param {string} agentId - Agent ID
   * @param {string} subdomain - Subdomain to use
   * @param {string} targetUrl - Target URL
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Result
   */
  async addHttpRoute(agentId, subdomain, targetUrl, options = {}) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info(
        `Adding HTTP route for ${subdomain}.${this.appDomain} to ${targetUrl}`
      );

      // Normalize targetUrl to ensure it has protocol
      if (
        !targetUrl.startsWith("http://") &&
        !targetUrl.startsWith("https://")
      ) {
        targetUrl = `http://${targetUrl}`;
      }

      // Create route entry
      const routeKey = `${agentId}-${subdomain}`;
      this.routes.http[routeKey] = {
        agentId,
        subdomain,
        targetUrl,
        options,
      };

      // Save routes to file
      const saved = await this.saveRoutes();
      if (!saved) {
        throw new AppError("Failed to save HTTP route configuration", 500);
      }

      return {
        success: true,
        message: `HTTP route added successfully for ${subdomain}.${this.appDomain}`,
        route: {
          agentId,
          subdomain,
          domain: `${subdomain}.${this.appDomain}`,
          targetUrl,
        },
      };
    } catch (err) {
      logger.error(`Failed to add HTTP route: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      throw err;
    }
  }

  /**
   * Add MongoDB route for an agent
   * @param {string} agentId - Agent ID
   * @param {string} targetHost - Target host
   * @param {number} targetPort - Target port
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Result
   */
  async addMongoDBRoute(agentId, targetHost, targetPort = 27017, options = {}) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info(
        `Adding MongoDB route for ${agentId}.${this.mongoDomain} to ${targetHost}:${targetPort}`
      );

      // Create route entry
      this.routes.mongodb[agentId] = {
        agentId,
        targetHost,
        targetPort,
        options,
      };

      // Save routes to file
      const saved = await this.saveRoutes();
      if (!saved) {
        throw new AppError("Failed to save MongoDB route configuration", 500);
      }

      return {
        success: true,
        message: `MongoDB route added successfully for ${agentId}.${this.mongoDomain}`,
        route: {
          agentId,
          domain: `${agentId}.${this.mongoDomain}`,
          targetHost,
          targetPort,
        },
      };
    } catch (err) {
      logger.error(`Failed to add MongoDB route: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      throw err;
    }
  }

  /**
   * Remove a route
   * @param {string} agentId - Agent ID
   * @param {string} subdomain - Subdomain (for HTTP routes)
   * @param {string} type - Route type ('http' or 'mongodb')
   * @returns {Promise<Object>} Result
   */
  async removeRoute(agentId, subdomain, type = "http") {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      if (type === "http") {
        if (!subdomain) {
          throw new AppError("Subdomain is required for HTTP routes", 400);
        }

        const routeKey = `${agentId}-${subdomain}`;
        if (!this.routes.http[routeKey]) {
          throw new AppError(
            `HTTP route not found for ${subdomain}.${this.appDomain}`,
            404
          );
        }

        logger.info(`Removing HTTP route for ${subdomain}.${this.appDomain}`);
        delete this.routes.http[routeKey];
      } else if (type === "mongodb") {
        if (!this.routes.mongodb[agentId]) {
          throw new AppError(
            `MongoDB route not found for ${agentId}.${this.mongoDomain}`,
            404
          );
        }

        logger.info(
          `Removing MongoDB route for ${agentId}.${this.mongoDomain}`
        );
        delete this.routes.mongodb[agentId];
      } else {
        throw new AppError(`Invalid route type: ${type}`, 400);
      }

      // Save routes to file
      const saved = await this.saveRoutes();
      if (!saved) {
        throw new AppError(
          `Failed to save route configuration after removing ${type} route`,
          500
        );
      }

      return {
        success: true,
        message: `${type.toUpperCase()} route removed successfully`,
        type,
        agentId,
        subdomain: type === "http" ? subdomain : undefined,
      };
    } catch (err) {
      logger.error(`Failed to remove route: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      throw err;
    }
  }

  /**
   * Get all routes for a specific agent
   * @param {string} agentId - Agent ID
   * @returns {Promise<Object>} Routes information
   */
  async getAgentRoutes(agentId) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      const httpRoutes = Object.values(this.routes.http)
        .filter((route) => route.agentId === agentId)
        .map((route) => ({
          type: "http",
          agentId: route.agentId,
          subdomain: route.subdomain,
          domain: `${route.subdomain}.${this.appDomain}`,
          targetUrl: route.targetUrl,
        }));

      const mongodbRoute = this.routes.mongodb[agentId];
      const mongodbRoutes = mongodbRoute
        ? [
            {
              type: "mongodb",
              agentId,
              domain: `${agentId}.${this.mongoDomain}`,
              targetHost: mongodbRoute.targetHost,
              targetPort: mongodbRoute.targetPort,
            },
          ]
        : [];

      return {
        success: true,
        agentId,
        routes: [...httpRoutes, ...mongodbRoutes],
      };
    } catch (err) {
      logger.error(`Failed to get agent routes: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      throw err;
    }
  }

  /**
   * Get all routes
   * @returns {Promise<Object>} All routes
   */
  async getAllRoutes() {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      const httpRoutes = Object.values(this.routes.http).map((route) => ({
        type: "http",
        agentId: route.agentId,
        subdomain: route.subdomain,
        domain: `${route.subdomain}.${this.appDomain}`,
        targetUrl: route.targetUrl,
      }));

      const mongodbRoutes = Object.values(this.routes.mongodb).map((route) => ({
        type: "mongodb",
        agentId: route.agentId,
        domain: `${route.agentId}.${this.mongoDomain}`,
        targetHost: route.targetHost,
        targetPort: route.targetPort,
      }));

      return {
        success: true,
        routes: [...httpRoutes, ...mongodbRoutes],
      };
    } catch (err) {
      logger.error(`Failed to get all routes: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      throw err;
    }
  }

  /**
   * Perform a health check on Traefik
   * @returns {Promise<Object>} Health status
   */
  async performHealthCheck() {
    try {
      // Check if Traefik container is running
      const containerStatus = await this.checkTraefikContainer();

      // Check if Traefik ping endpoint is accessible
      let pingHealthy = false;
      let pingResponseDetails = null;

      if (containerStatus.running) {
        try {
          // Try various ways to connect to Traefik's ping endpoint
          // Note: In Traefik v2, the ping endpoint is at /api/ping when API is enabled
          const pingEndpoints = [
            `http://${this.traefikContainer}:8081/api/ping`,
            `http://localhost:8081/api/ping`,
            `http://127.0.0.1:8081/api/ping`,
            // Fallbacks to dashboard and root as health indicators
            `http://${this.traefikContainer}:8081/dashboard/`,
            `http://${this.traefikContainer}:8081/`,
          ];

          for (const endpoint of pingEndpoints) {
            try {
              await withRetry(
                async () => {
                  const response = await axios.get(endpoint, {
                    timeout: 2000,
                    validateStatus: (status) => status < 500, // Accept any non-5xx response as "up"
                  });
                  pingResponseDetails = {
                    endpoint,
                    status: response.status,
                    data: response.data,
                  };
                  return true;
                },
                { maxRetries: 1, initialDelay: 300 }
              );
              pingHealthy = true;
              logger.info(
                `Successfully connected to Traefik endpoint at ${endpoint}`
              );
              break; // Exit the loop if successful
            } catch (err) {
              logger.debug(
                `Failed to ping Traefik at ${endpoint}: ${err.message}`
              );
              // Continue to the next endpoint
            }
          }

          if (!pingHealthy) {
            logger.warn("Could not connect to any Traefik health endpoint");
          }
        } catch (pingErr) {
          logger.warn(`Failed to ping Traefik: ${pingErr.message}`);
          pingHealthy = false;
        }
      }

      // Don't fail initialization if Traefik isn't ready yet
      // Instead, mark it as degraded but still allow the app to function

      // Update health status
      this.healthStatus = {
        status: containerStatus.running
          ? pingHealthy
            ? "healthy"
            : "degraded"
          : "unhealthy",
        lastCheck: {
          timestamp: new Date().toISOString(),
          result: containerStatus.running
            ? pingHealthy
              ? "success"
              : "partial"
            : "failure",
        },
        details: {
          containerRunning: containerStatus.running,
          pingHealthy,
          pingResponse: pingResponseDetails,
          containerDetails: containerStatus,
          message: pingHealthy
            ? "Traefik is functioning normally"
            : containerStatus.running
            ? "Traefik container is running but API is not responding"
            : "Traefik container is not running",
        },
      };

      return this.healthStatus.details;
    } catch (err) {
      logger.error(`Health check failed: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });

      this.healthStatus = {
        status: "unknown",
        lastCheck: {
          timestamp: new Date().toISOString(),
          result: "error",
        },
        details: {
          containerRunning: false,
          pingHealthy: false,
          configValid: false,
          error: err.message,
          message: `Error checking Traefik health: ${err.message}`,
        },
      };

      return this.healthStatus.details;
    }
  }

  /**
   * Get the current health status
   * @returns {Object} Health status
   */
  getHealthStatus() {
    // If we've never checked health, perform a check
    if (!this.healthStatus.lastCheck) {
      return this.performHealthCheck();
    }

    return this.healthStatus;
  }

  /**
   * Get Traefik stats
   * @returns {Promise<Object>} Traefik stats
   */
  async getStats() {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      // Health check to ensure Traefik is running
      const health = await this.performHealthCheck();
      if (!health.containerRunning) {
        throw new AppError("Traefik container is not running", 503);
      }

      // Count routes
      const httpRouteCount = Object.keys(this.routes.http).length;
      const mongodbRouteCount = Object.keys(this.routes.mongodb).length;

      // Get container stats
      const { stdout } = await exec(
        `docker stats ${this.traefikContainer} --no-stream --format "{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}|{{.BlockIO}}"`
      );
      const [cpuPerc, memUsage, netIO, blockIO] = stdout.trim().split("|");

      return {
        success: true,
        routeStats: {
          total: httpRouteCount + mongodbRouteCount,
          http: httpRouteCount,
          mongodb: mongodbRouteCount,
        },
        containerStats: {
          cpuPerc,
          memUsage,
          netIO,
          blockIO,
        },
        health: this.healthStatus,
      };
    } catch (err) {
      logger.error(`Failed to get Traefik stats: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });
      throw err;
    }
  }

  /**
   * Validate Traefik configuration
   * @returns {Promise<Object>} Validation result
   */
  async validateConfig() {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      // Check if Traefik container is running
      const containerStatus = await this.checkTraefikContainer();
      if (!containerStatus.running) {
        return {
          success: false,
          message: "Traefik container is not running",
          details: containerStatus,
        };
      }

      try {
        // Run the healthcheck command
        const { stdout, stderr } = await exec(
          `docker exec ${this.traefikContainer} traefik healthcheck`
        );
        return {
          success: true,
          message: "Traefik configuration is valid",
          details: {
            output: stdout.trim(),
            warnings: stderr.trim(),
          },
        };
      } catch (err) {
        // Don't treat this as a fatal error - just log it and return a degraded status
        logger.warn(`Config validation warning: ${err.message}`, {
          error: err.message,
          stderr: err.stderr,
        });

        return {
          success: false,
          message: `Traefik configuration validation warning: ${err.message}`,
          details: {
            error: err.message,
            stderr: err.stderr,
          },
        };
      }
    } catch (err) {
      logger.error(`Failed to validate Traefik configuration: ${err.message}`, {
        error: err.message,
        stderr: err.stderr,
      });

      return {
        success: false,
        message: `Traefik configuration is invalid: ${err.message}`,
        details: {
          error: err.message,
          stderr: err.stderr,
        },
      };
    }
  }

  /**
   * Recover Traefik service
   * @returns {Promise<Object>} Recovery result
   */
  async recoverService() {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info("Attempting to recover Traefik service");

      // Check current status
      const health = await this.performHealthCheck();

      // If healthy, no need to recover
      if (health.containerRunning && health.pingHealthy) {
        return {
          success: true,
          message: "Traefik service is already healthy",
          action: "none",
        };
      }

      // Try to restart container
      logger.info("Restarting Traefik container");
      const { stdout, stderr } = await exec(
        `docker restart ${this.traefikContainer}`
      );

      // Wait a moment for the container to restart
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Check if recovery was successful
      const recoveryHealth = await this.performHealthCheck();

      if (recoveryHealth.containerRunning && recoveryHealth.pingHealthy) {
        return {
          success: true,
          message: "Traefik service recovered successfully",
          action: "restart",
        };
      } else {
        // If restart didn't work, log the failure but return partial success
        logger.warn("Traefik service only partially recovered", {
          containerRunning: recoveryHealth.containerRunning,
          pingHealthy: recoveryHealth.pingHealthy,
        });

        return {
          success: false,
          message: "Traefik service only partially recovered",
          action: "restart",
          details: recoveryHealth,
        };
      }
    } catch (err) {
      logger.error(`Failed to recover Traefik service: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });

      return {
        success: false,
        message: `Failed to recover Traefik service: ${err.message}`,
        action: "failed",
        error: err.message,
      };
    }
  }

  /**
   * Check Traefik container status
   * @returns {Promise<Object>} Container status
   */
  async checkTraefikContainer() {
    try {
      const { stdout } = await exec(
        `docker ps -a --format "{{.Names}},{{.Status}},{{.Ports}}" --filter "name=${this.traefikContainer}"`
      );

      if (!stdout.trim()) {
        return {
          running: false,
          error: "No Traefik container found",
        };
      }

      const [name, status, ports] = stdout.trim().split(",");
      const isRunning =
        status.includes("Up") &&
        !status.includes("(unhealthy)") &&
        !status.includes("(Restarting)");

      return {
        running: isRunning,
        name,
        status,
        ports,
        restartStatus: status.includes("Restarting") ? "restarting" : "normal",
        healthStatus: status.includes("(healthy)")
          ? "healthy"
          : status.includes("(unhealthy)")
          ? "unhealthy"
          : status.includes("(health: starting)")
          ? "starting"
          : "unknown",
      };
    } catch (err) {
      logger.error(`Failed to check Traefik container: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });

      return {
        running: false,
        error: err.message,
      };
    }
  }

  /**
   * Diagnose MongoDB connection issues
   * @param {string} agentId - Agent ID to diagnose
   * @returns {Promise<Object>} Diagnostic result
   */
  async diagnoseMongoDBConnection(agentId) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      // Check if route exists
      const mongoRoute = this.routes.mongodb[agentId];
      if (!mongoRoute) {
        return {
          success: false,
          message: `No MongoDB route found for agent ${agentId}`,
          diagnostics: {
            routeExists: false,
          },
        };
      }

      // Load configuration to verify what's actually in the file
      const routesYaml = await fs.readFile(this.routesConfigPath, "utf8");
      const config = yaml.load(routesYaml) || {};

      const routerName = `mongodb-${agentId}`;
      const serviceName = `mongodb-service-${agentId}`;

      const configRouter = config.tcp?.routers?.[routerName];
      const configService = config.tcp?.services?.[serviceName];

      // Get the address from the config file
      let configuredAddress = "unknown";
      if (
        configService?.loadBalancer?.servers &&
        configService.loadBalancer.servers.length > 0
      ) {
        configuredAddress = configService.loadBalancer.servers[0].address;
      }

      // Run connectivity test
      const { targetHost, targetPort } = mongoRoute;
      let connectivityResult = false;
      let errorMessage = null;

      try {
        // Check if port is open using netcat or telnet
        const { stdout, stderr } = await exec(
          `docker exec ${this.traefikContainer} timeout 5 bash -c "echo > /dev/tcp/${targetHost}/${targetPort}"`
        );
        connectivityResult = true;
      } catch (err) {
        connectivityResult = false;
        errorMessage = err.message;
      }

      return {
        success: true,
        message: `MongoDB diagnostic complete for ${agentId}.${this.mongoDomain}`,
        diagnostics: {
          routeExists: true,
          inMemoryRoute: {
            targetHost: mongoRoute.targetHost,
            targetPort: mongoRoute.targetPort,
          },
          configuredRoute: {
            router: configRouter ? true : false,
            service: configService ? true : false,
            address: configuredAddress,
          },
          connectivityTest: {
            success: connectivityResult,
            error: errorMessage,
          },
          recommendation: connectivityResult
            ? "Connection to MongoDB server appears available. Check if MongoDB is running and properly configured for TLS."
            : `Cannot connect to MongoDB at ${targetHost}:${targetPort}. Ensure the host is reachable and the port is open.`,
        },
      };
    } catch (err) {
      logger.error(`Failed to diagnose MongoDB connection: ${err.message}`, {
        error: err.message,
        stack: err.stack,
      });

      return {
        success: false,
        message: `Failed to diagnose MongoDB connection: ${err.message}`,
        diagnostics: {
          error: err.message,
        },
      };
    }
  }
}

module.exports = TraefikService;
