/**
 * MongoDB Registration Handler
 *
 * This module provides robust MongoDB registration with Traefik.
 */
const fs = require("fs").promises;
const { promisify } = require("util");
const exec = promisify(require("child_process").exec);
const Docker = require("dockerode");
const logger = require("./logger").getLogger("mongoRegistration");
const configManager = require("./configManager");

const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const MONGO_DOMAIN = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";

/**
 * Check if Traefik has MongoDB port exposed
 */
async function checkTraefikMongoPort() {
  try {
    const containers = await docker.listContainers({
      filters: { name: ["traefik"] },
    });

    if (containers.length === 0) {
      logger.error("No Traefik container found");
      return false;
    }

    const traefikContainer = containers[0];
    const ports = traefikContainer.Ports || [];

    // Check if port 27017 is properly exposed
    const mongoPortExposed = ports.some((port) => port.PublicPort === 27017);

    if (!mongoPortExposed) {
      logger.warn("MongoDB port 27017 is not exposed in Traefik container");
      return false;
    }

    return true;
  } catch (err) {
    logger.error("Error checking Traefik MongoDB port:", err);
    return false;
  }
}

/**
 * Ensure Traefik has MongoDB entrypoint configured
 */
async function ensureMongoDBEntrypoint() {
  try {
    // First check if the port is properly exposed
    const isPortExposed = await checkTraefikMongoPort();

    if (!isPortExposed) {
      logger.warn("MongoDB port not properly exposed - will attempt to fix");
      await fixTraefikMongoPortExposure();
    }

    // Now ensure the configuration has a proper TCP router for MongoDB
    const config = await configManager.getAgentConfig("default");

    // Ensure TCP section exists with MongoDB catchall router
    if (!config.tcp) {
      config.tcp = { routers: {}, services: {} };
    }

    if (!config.tcp.routers["mongodb-catchall"]) {
      config.tcp.routers["mongodb-catchall"] = {
        rule: `HostSNI(\`*.${MONGO_DOMAIN}\`)`,
        service: "mongodb-catchall-service",
        entryPoints: ["mongodb"],
        tls: {
          passthrough: true,
        },
      };

      config.tcp.services["mongodb-catchall-service"] = {
        loadBalancer: {
          servers: [],
        },
      };

      // Save the updated configuration
      await configManager.saveAgentConfig("default", config);
      logger.info("Added MongoDB catchall router to configuration");
    }

    return true;
  } catch (err) {
    logger.error("Error ensuring MongoDB entrypoint:", err);
    return false;
  }
}

/**
 * Fix Traefik MongoDB port exposure in Docker Compose
 */
async function fixTraefikMongoPortExposure() {
  try {
    logger.info("Attempting to fix Traefik MongoDB port exposure");

    // Get the base directory from environment or use a default
    const baseDir = process.env.BASE_DIR || "/opt/cloudlunacy_front";
    const composeFilePath = `${baseDir}/docker-compose.yml`;

    // Read the docker-compose.yml file
    const composeContent = await fs.readFile(composeFilePath, "utf8");

    // Check if port 27017 is already in the file
    if (!composeContent.includes('"27017:27017"')) {
      // Add the port to ports section
      const updatedContent = composeContent.replace(
        /ports:([^\]]*?)(\s+-)(\s+)"8081:8081"/s,
        'ports:$1$2$3"8081:8081"$2$3"27017:27017"'
      );

      // Write the updated file
      await fs.writeFile(composeFilePath, updatedContent);
      logger.info("Updated docker-compose.yml to include MongoDB port");

      // Restart the Traefik container
      try {
        await exec(`cd ${baseDir} && docker-compose up -d traefik`);
        logger.info("Traefik container restarted with MongoDB port exposed");

        // Give some time for Traefik to start up
        await new Promise((resolve) => setTimeout(resolve, 5000));

        // Verify port is now exposed
        const isExposed = await checkTraefikMongoPort();
        if (!isExposed) {
          logger.warn("MongoDB port still not properly exposed after restart");
        }

        return isExposed;
      } catch (execErr) {
        logger.error("Error restarting Traefik container:", execErr);
        return false;
      }
    } else {
      logger.info("MongoDB port already defined in docker-compose.yml");

      // Check if Traefik container needs to be restarted
      const containers = await docker.listContainers({
        filters: { name: ["traefik"] },
      });

      if (containers.length > 0) {
        const traefikContainer = docker.getContainer(containers[0].Id);

        // Restart the container to apply port changes
        await traefikContainer.restart({ t: 10 });
        logger.info("Traefik container restarted to apply configuration");

        // Give some time for Traefik to start up
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }

      return true;
    }
  } catch (err) {
    logger.error("Error fixing Traefik MongoDB port exposure:", err);
    return false;
  }
}

/**
 * Trigger Traefik reload using the Docker API.
 */
async function triggerTraefikReload() {
  try {
    logger.info("Attempting to restart Traefik container...");
    const Docker = require("dockerode");
    const docker = new Docker({ socketPath: "/var/run/docker.sock" });

    // Find the Traefik container
    const containers = await docker.listContainers({
      filters: { name: ["traefik"] },
    });

    if (containers.length === 0) {
      logger.error("No Traefik container found");
      return false;
    }

    const traefikContainer = docker.getContainer(containers[0].Id);
    const containerId = containers[0].Id.substring(0, 12);

    // Restart the container
    logger.info(`Restarting Traefik container ${containerId}...`);
    await traefikContainer.restart({ t: 10 }); // 10 seconds timeout

    logger.info("Traefik restarted successfully");
    return true;
  } catch (error) {
    logger.error("Failed to restart Traefik:", {
      error: error.message,
      stack: error.stack,
    });
    return false;
  }
}

/**
 * Register a MongoDB instance with Traefik
 */
async function registerMongoDB(agentId, targetIp) {
  try {
    logger.info(`Registering MongoDB for agent ${agentId} at ${targetIp}`);

    // Ensure MongoDB entrypoint is properly configured
    await ensureMongoDBEntrypoint();

    // Get the agent's configuration
    const config = await configManager.getAgentConfig(agentId);

    // Ensure TCP section exists
    if (!config.tcp) {
      config.tcp = { routers: {}, services: {} };
    }

    // Define router name and service name
    const routerName = `mongodb-${agentId}`;
    const serviceName = `mongodb-${agentId}-service`;

    // Add TCP router for this agent's MongoDB - use wildcards in rule for better matching
    config.tcp.routers[routerName] = {
      rule: `HostSNI(\`${agentId}.${MONGO_DOMAIN}\`) || HostSNI(\`*\`)`,
      entryPoints: ["mongodb"],
      service: serviceName,
      tls: {
        passthrough: true,
      },
    };

    // Add the service that points to the agent's MongoDB
    config.tcp.services[serviceName] = {
      loadBalancer: {
        servers: [{ address: `${targetIp}:27017` }],
      },
    };

    // Save the updated configuration
    try {
      // Get the path where the config should be saved
      const configPath = await configManager.getAgentConfigPath(agentId);
      logger.info(`Saving MongoDB configuration to ${configPath}`);

      // Save using the configManager
      await configManager.saveAgentConfig(agentId, config);

      // Verify the file was actually created
      const fs = require("fs").promises;
      try {
        await fs.access(configPath);
        logger.info(`Verified config file exists at: ${configPath}`);
      } catch (accessErr) {
        logger.error(
          `Config file not found at ${configPath} after saving. Error: ${accessErr.message}`
        );

        // Attempt a direct file write as a fallback
        try {
          const yaml = require("yaml");
          const configDir = path.dirname(configPath);

          // Ensure directory exists
          await fs.mkdir(configDir, { recursive: true });

          // Write file directly
          const yamlContent = yaml.stringify(config);
          await fs.writeFile(configPath, yamlContent, "utf8");
          logger.info(`Fallback: Directly wrote config to ${configPath}`);

          // Also try writing to /etc/traefik/agents as a double-fallback
          const etcPath = `/etc/traefik/agents/${agentId}.yml`;
          try {
            await fs.mkdir("/etc/traefik/agents", { recursive: true });
            await fs.writeFile(etcPath, yamlContent, "utf8");
            logger.info(`Double-fallback: Wrote config to ${etcPath}`);
          } catch (etcErr) {
            logger.error(`Failed to write to ${etcPath}: ${etcErr.message}`);
          }
        } catch (writeErr) {
          logger.error(`Failed direct file write: ${writeErr.message}`);
        }
      }

      // Try to trigger a Traefik reload
      try {
        await triggerTraefikReload();
      } catch (reloadErr) {
        logger.error(`Failed to reload Traefik: ${reloadErr.message}`);
      }
    } catch (saveErr) {
      logger.error(
        `Failed to save configuration for agent ${agentId}: ${saveErr.message}`
      );
      throw saveErr;
    }

    logger.info(`MongoDB registered for agent ${agentId} at ${targetIp}`);

    return {
      success: true,
      mongodbUrl: `${agentId}.${MONGO_DOMAIN}`,
      targetIp,
    };
  } catch (err) {
    logger.error(
      `Failed to register MongoDB for agent ${agentId}: ${err.message}`
    );
    throw err;
  }
}
/**
 * Validate MongoDB inputs
 */
function validateMongoDBInputs(subdomain, targetIp) {
  const subdomainRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const ipRegex =
    /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

  return {
    isValid: subdomainRegex.test(subdomain) && ipRegex.test(targetIp),
    details: {
      subdomain: {
        value: subdomain,
        valid: subdomainRegex.test(subdomain),
      },
      targetIp: {
        value: targetIp,
        valid: ipRegex.test(targetIp),
      },
    },
  };
}

module.exports = {
  checkTraefikMongoPort,
  ensureMongoDBEntrypoint,
  registerMongoDB,
  validateMongoDBInputs,
};
