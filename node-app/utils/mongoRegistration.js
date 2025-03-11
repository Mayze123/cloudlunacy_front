// Enhanced mongoRegistration.js with better error handling and diagnostics

const fs = require("fs").promises;
const path = require("path");
const { promisify } = require("util");
const exec = promisify(require("child_process").exec);
const Docker = require("dockerode");
const logger = require("./logger").getLogger("mongoRegistration");
const configManager = require("./configManager");
const yaml = require("yaml");

const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const MONGO_DOMAIN = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";

/**
 * Test MongoDB connectivity to verify routing works
 */
async function testMongoConnection(targetIp, agentId) {
  try {
    logger.info(
      `Testing MongoDB connectivity to ${targetIp} (agentId: ${agentId})`
    );

    // First test direct connection to MongoDB (no TLS)
    try {
      const { stdout, stderr } = await exec(
        `timeout 5 nc -zv ${targetIp} 27017`
      );
      logger.info(
        `Direct MongoDB connection test: ${stdout.trim() || "No output"}`
      );
      if (stderr) logger.warn(`Connection test stderr: ${stderr.trim()}`);
    } catch (directErr) {
      logger.warn(
        `Direct connection to MongoDB at ${targetIp}:27017 failed: ${directErr.message}`
      );
    }

    // Then test TLS connection to MongoDB through Traefik
    const mongoUrl = `${agentId}.${MONGO_DOMAIN}`;
    try {
      const { stdout, stderr } = await exec(
        `timeout 5 nc -zv ${mongoUrl} 27017`
      );
      logger.info(
        `Traefik MongoDB connection test: ${stdout.trim() || "No output"}`
      );
      if (stderr) logger.warn(`Connection test stderr: ${stderr.trim()}`);
      return true;
    } catch (tlsErr) {
      logger.warn(
        `TLS connection to MongoDB at ${mongoUrl}:27017 failed: ${tlsErr.message}`
      );
      return false;
    }
  } catch (err) {
    logger.error(`Error testing MongoDB connection: ${err.message}`);
    return false;
  }
}

/**
 * Check DNS resolution for MongoDB domain
 */
async function checkDnsResolution(domain) {
  try {
    const { stdout, stderr } = await exec(`host ${domain}`);
    logger.info(`DNS resolution for ${domain}: ${stdout.trim()}`);
    return true;
  } catch (err) {
    logger.warn(`DNS resolution failed for ${domain}: ${err.message}`);
    return false;
  }
}

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

    logger.info("MongoDB port 27017 is properly exposed in Traefik container");
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
    // We'll directly modify the main Traefik configuration file to ensure it's correct
    try {
      const dynamicConfigPath = "/etc/traefik/dynamic.yml";

      try {
        // Try to read the current config
        const content = await fs.readFile(dynamicConfigPath, "utf8");
        let config;

        try {
          // Try to parse the YAML
          config = yaml.parse(content);
          logger.info("Successfully parsed Traefik dynamic config");
        } catch (parseErr) {
          logger.error(`Error parsing dynamic config: ${parseErr.message}`);
          // Create a backup of the corrupted file
          const backupPath = `${dynamicConfigPath}.backup.${Date.now()}`;
          await fs.copyFile(dynamicConfigPath, backupPath);
          logger.info(`Backed up corrupted config to ${backupPath}`);

          // Create a new config with the default structure
          config = {
            http: {
              routers: {
                dashboard: {
                  rule: "Host(`traefik.localhost`) && (PathPrefix(`/api`) || PathPrefix(`/dashboard`))",
                  service: "api@internal",
                  entryPoints: ["dashboard"],
                  middlewares: ["auth"],
                },
              },
              middlewares: {
                auth: {
                  basicAuth: {
                    users: ["admin:$apr1$H6uskkkW$IgXLP6ewTrSuBkTrqE8wj/"],
                  },
                },
                "web-to-websecure": {
                  redirectScheme: {
                    scheme: "https",
                    permanent: true,
                  },
                },
              },
              services: {},
            },
            tcp: {
              routers: {},
              services: {},
            },
          };
        }

        // Ensure TCP section exists
        if (!config.tcp) {
          config.tcp = { routers: {}, services: {} };
          logger.info("Added missing tcp section to config");
        }

        // Ensure MongoDB catchall router exists
        if (!config.tcp.routers || !config.tcp.services) {
          config.tcp.routers = config.tcp.routers || {};
          config.tcp.services = config.tcp.services || {};
          logger.info("Added missing tcp.routers and tcp.services sections");
        }

        // Add MongoDB catchall router if it doesn't exist
        if (!config.tcp.routers["mongodb-catchall"]) {
          config.tcp.routers["mongodb-catchall"] = {
            rule: `HostSNI(\`*.${MONGO_DOMAIN}\`)`,
            service: "mongodb-catchall-service",
            entryPoints: ["mongodb"],
            tls: {
              passthrough: true,
            },
          };
          logger.info("Added mongodb-catchall router to config");
        }

        // Add MongoDB catchall service if it doesn't exist
        if (!config.tcp.services["mongodb-catchall-service"]) {
          config.tcp.services["mongodb-catchall-service"] = {
            loadBalancer: {
              servers: [],
            },
          };
          logger.info("Added mongodb-catchall-service to config");
        }

        // Write the updated config back to the file
        const yamlStr = yaml.stringify(config, {
          indent: 2,
          aliasDuplicateObjects: false,
        });

        await fs.writeFile(dynamicConfigPath, yamlStr, "utf8");
        logger.info("Successfully updated Traefik dynamic config");

        // Now also try to fix through the configManager
        await configManager.initialize();
      } catch (readErr) {
        logger.error(`Error reading dynamic config: ${readErr.message}`);

        // Try to create a new default config through the configManager
        try {
          logger.info(
            "Attempting to create new dynamic config through configManager"
          );
          await configManager.ensureMainConfig();
        } catch (managerErr) {
          logger.error(
            `ConfigManager failed to ensure main config: ${managerErr.message}`
          );
        }
      }
    } catch (configErr) {
      logger.error(
        `Error ensuring MongoDB configuration: ${configErr.message}`
      );
    }

    // Return result of port check
    const finalCheck = await checkTraefikMongoPort();
    return finalCheck;
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

    // Try to find and fix the docker-compose.yml file
    const possibleLocations = [
      "/opt/cloudlunacy_front/docker-compose.yml",
      "./docker-compose.yml",
      "/docker-compose.yml",
    ];

    let composeFilePath = null;
    let composeContent = null;

    // Find the first existing docker-compose file
    for (const location of possibleLocations) {
      try {
        composeContent = await fs.readFile(location, "utf8");
        composeFilePath = location;
        logger.info(`Found docker-compose.yml at ${location}`);
        break;
      } catch (readErr) {
        // Continue to next location
      }
    }

    if (!composeFilePath) {
      logger.error("Could not find docker-compose.yml file");

      // As a last resort, try to restart the Traefik container directly
      try {
        logger.info("Attempting to restart Traefik container directly");
        const containers = await docker.listContainers({
          filters: { name: ["traefik"] },
        });

        if (containers.length > 0) {
          const containerId = containers[0].Id;
          const container = docker.getContainer(containerId);
          await container.restart({ t: 10 });
          logger.info("Restarted Traefik container directly");

          // Wait for container to start up
          await new Promise((resolve) => setTimeout(resolve, 5000));

          return true;
        }
      } catch (restartErr) {
        logger.error(
          `Failed to restart Traefik container: ${restartErr.message}`
        );
      }

      return false;
    }

    // Check if port 27017 is already in the file
    if (!composeContent.includes('"27017:27017"')) {
      // Add the port to ports section
      let updatedContent;

      // First pattern to try - specific port format
      try {
        updatedContent = composeContent.replace(
          /ports:([^\]]*?)(\s+-)(\s+)"8081:8081"/s,
          'ports:$1$2$3"8081:8081"$2$3"27017:27017"'
        );

        // If no replacement occurred, try a more general pattern
        if (updatedContent === composeContent) {
          logger.info("First pattern didn't match, trying alternative pattern");
          updatedContent = composeContent.replace(
            /(ports:\s*(?:-\s+[^\s]+\s+)+)/s,
            '$1- "27017:27017"\n      '
          );
        }

        // If still no replacement, try another pattern
        if (updatedContent === composeContent) {
          logger.info(
            "Second pattern didn't match, trying last resort pattern"
          );
          updatedContent = composeContent.replace(
            /(ports:.*?)\n/s,
            '$1\n      - "27017:27017"\n'
          );
        }

        // If still no replacement, give up
        if (updatedContent === composeContent) {
          logger.error(
            "Could not modify docker-compose.yml file - no matching patterns"
          );
          return false;
        }

        // Write the updated file
        await fs.writeFile(composeFilePath, updatedContent);
        logger.info("Updated docker-compose.yml to include MongoDB port");

        // Restart the services
        try {
          const baseDir = path.dirname(composeFilePath);
          await exec(`cd ${baseDir} && docker-compose up -d`);
          logger.info("Restarted services with updated configuration");

          // Wait for services to start
          await new Promise((resolve) => setTimeout(resolve, 5000));

          return true;
        } catch (restartErr) {
          logger.error(`Failed to restart services: ${restartErr.message}`);
          return false;
        }
      } catch (err) {
        logger.error(`Error updating docker-compose.yml: ${err.message}`);
        return false;
      }
    } else {
      logger.info("MongoDB port already defined in docker-compose.yml");

      // Restart services to ensure proper configuration
      try {
        const baseDir = path.dirname(composeFilePath);
        await exec(`cd ${baseDir} && docker-compose up -d`);
        logger.info("Restarted services to ensure proper configuration");

        // Wait for services to start
        await new Promise((resolve) => setTimeout(resolve, 5000));

        return true;
      } catch (restartErr) {
        logger.error(`Failed to restart services: ${restartErr.message}`);
        return false;
      }
    }
  } catch (err) {
    logger.error(`Error fixing Traefik MongoDB port exposure: ${err.message}`);
    return false;
  }
}

/**
 * Trigger Traefik reload using the Docker API.
 */
async function triggerTraefikReload() {
  try {
    logger.info("Attempting to restart Traefik container...");

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

    // Wait for the container to start up
    await new Promise((resolve) => setTimeout(resolve, 5000));

    return true;
  } catch (error) {
    logger.error(`Failed to restart Traefik: ${error.message}`);
    return false;
  }
}

/**
 * Register a MongoDB instance with Traefik
 */
async function registerMongoDB(agentId, targetIp) {
  try {
    logger.info(`Registering MongoDB for agent ${agentId} at ${targetIp}`);

    // Run diagnostics
    const portExposed = await checkTraefikMongoPort();
    if (!portExposed) {
      logger.warn("MongoDB port not exposed in Traefik - attempting to fix");
      await ensureMongoDBEntrypoint();
    }

    // Check DNS resolution
    const mongoUrl = `${agentId}.${MONGO_DOMAIN}`;
    await checkDnsResolution(mongoUrl);

    // Get the agent's configuration - use the configManager
    await configManager.initialize();
    const config = await configManager.getAgentConfig(agentId);

    // Ensure TCP section exists
    if (!config.tcp) {
      config.tcp = { routers: {}, services: {} };
    }

    // Define router name and service name
    const routerName = `mongodb-${agentId}`;
    const serviceName = `mongodb-${agentId}-service`;

    // Add TCP router for this agent's MongoDB
    config.tcp.routers[routerName] = {
      rule: `HostSNI(\`${agentId}.${MONGO_DOMAIN}\`)`,
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

    // Save the agent config
    try {
      await configManager.saveAgentConfig(agentId, config);
      logger.info(`Successfully saved agent config for ${agentId}`);
    } catch (saveErr) {
      logger.error(`Failed to save agent config: ${saveErr.message}`);

      // Try manual file write as a fallback
      try {
        const agentConfigPath = `/etc/traefik/agents/${agentId}.yml`;
        logger.info(`Attempting manual write to ${agentConfigPath}`);

        // Create directory if needed
        await fs.mkdir("/etc/traefik/agents", { recursive: true });

        // Format the YAML
        const yamlStr = yaml.stringify(config, {
          indent: 2,
          aliasDuplicateObjects: false,
        });

        // Write the file
        await fs.writeFile(agentConfigPath, yamlStr, "utf8");
        logger.info(`Successfully wrote agent config to ${agentConfigPath}`);
      } catch (manualErr) {
        logger.error(`Manual file write also failed: ${manualErr.message}`);
        throw saveErr;
      }
    }

    // Trigger Traefik reload
    await triggerTraefikReload();

    // Test the connection
    await testMongoConnection(targetIp, agentId);

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

/**
 * List all configured MongoDB registrations
 */
async function listMongoDBRegistrations() {
  try {
    logger.info("Listing all MongoDB registrations");

    // Initialize config manager
    await configManager.initialize();

    // Get all agent IDs
    const agents = await configManager.listAgents();

    const registrations = [];

    // For each agent, check if it has MongoDB registrations
    for (const agentId of agents) {
      try {
        const config = await configManager.getAgentConfig(agentId);

        // Check for MongoDB routers
        if (config.tcp && config.tcp.routers) {
          for (const [routerName, router] of Object.entries(
            config.tcp.routers
          )) {
            if (routerName.startsWith("mongodb-") && router.service) {
              const serviceName = router.service;

              if (config.tcp.services && config.tcp.services[serviceName]) {
                const service = config.tcp.services[serviceName];

                if (
                  service.loadBalancer &&
                  service.loadBalancer.servers &&
                  service.loadBalancer.servers.length > 0
                ) {
                  for (const server of service.loadBalancer.servers) {
                    registrations.push({
                      agentId,
                      routerName,
                      serviceName,
                      mongoUrl: `${agentId}.${MONGO_DOMAIN}`,
                      targetAddress: server.address,
                    });
                  }
                }
              }
            }
          }
        }
      } catch (agentErr) {
        logger.error(`Error processing agent ${agentId}: ${agentErr.message}`);
      }
    }

    logger.info(`Found ${registrations.length} MongoDB registrations`);
    return registrations;
  } catch (err) {
    logger.error(`Error listing MongoDB registrations: ${err.message}`);
    return [];
  }
}

module.exports = {
  checkTraefikMongoPort,
  ensureMongoDBEntrypoint,
  registerMongoDB,
  validateMongoDBInputs,
  listMongoDBRegistrations,
  triggerTraefikReload,
  testMongoConnection,
};
