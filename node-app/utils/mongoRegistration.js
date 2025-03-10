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
 * Register a MongoDB instance with Traefik
 */
// In node-app/utils/mongoRegistration.js
async function registerMongoDB(agentId, targetIp) {
  try {
    logger.info(`Registering MongoDB for agent ${agentId} at ${targetIp}`);

    // Get the agent's configuration
    const config = await configManager.getAgentConfig(agentId);

    // Add MongoDB routing configuration
    if (!config.tcp) config.tcp = { routers: {}, services: {} };

    config.tcp.routers[`mongodb-${agentId}`] = {
      rule: `HostSNI(\`${agentId}.${MONGO_DOMAIN}\`)`,
      entryPoints: ["mongodb"],
      service: `mongodb-${agentId}-service`,
      tls: { passthrough: true },
    };

    config.tcp.services[`mongodb-${agentId}-service`] = {
      loadBalancer: {
        servers: [{ address: `${targetIp}:27017` }],
      },
    };

    // Save the configuration and verify it worked
    const configPath = await configManager.getAgentConfigPath(agentId);
    logger.info(`Saving MongoDB configuration to: ${configPath}`);

    await configManager.saveAgentConfig(agentId, config);

    // Verify the file exists after saving
    try {
      const fs = require("fs").promises;
      await fs.access(configPath);
      logger.info(`Successfully verified config file exists at: ${configPath}`);
    } catch (accessErr) {
      logger.error(
        `Failed to verify config file at ${configPath}: ${accessErr.message}`
      );
      // Try writing directly to the file as a fallback
      try {
        const yaml = require("yaml");
        const fs = require("fs").promises;
        await fs.writeFile(configPath, yaml.stringify(config), "utf8");
        logger.info(`Fallback file write succeeded to: ${configPath}`);
      } catch (writeErr) {
        logger.error(`Fallback file write failed: ${writeErr.message}`);
      }
    }

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
