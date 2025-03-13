// services/mongodbManager.js
/**
 * MongoDB Manager
 * 
 * Handles MongoDB routing, connection testing, and TLS termination
 */

const { execSync, exec } = require('child_process');
const { promisify } = require('util');
const net = require('net');
const dns = require('dns').promises;
const Docker = require('dockerode');
const configManager = require('./configManager');
const logger = require('../utils/logger').getLogger('mongodbManager');

const execAsync = promisify(exec);
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

class MongoDBManager {
  constructor() {
    this.mongoDomain = process.env.MONGO_DOMAIN || 'mongodb.cloudlunacy.uk';
    this.portNumber = 27017;
    this.connectTimeout = 5000; // 5 seconds
    this.initialized = false;
    this.registeredAgents = new Map(); // Store agent registrations
  }

  /**
   * Initialize the MongoDB manager
   */
  async initialize() {
    if (this.initialized) {
      return true;
    }

    try {
      logger.info('Initializing MongoDB manager');

      // Ensure MongoDB port is exposed in Traefik
      const portExposed = await this.checkMongoDBPort();
      if (!portExposed) {
        logger.warn('MongoDB port not exposed in Traefik, attempting to fix');
        await this.ensureMongoDBPort();
      }

      // Ensure MongoDB catchall router exists
      await this.ensureMongoDBEntrypoint();

      this.initialized = true;
      logger.info('MongoDB manager initialized successfully');
      return true;
    } catch (err) {
      logger.error(`Failed to initialize MongoDB manager: ${err.message}`, {
        error: err.message,
        stack: err.stack
      });
      throw err;
    }
  }

  /**
   * Check if MongoDB port is exposed in Traefik
   */
  async checkMongoDBPort() {
    try {
      logger.debug('Checking if MongoDB port is exposed in Traefik');

      // Check if Traefik container exists
      const containers = await docker.listContainers({
        filters: { name: ['traefik'] }
      });

      if (containers.length === 0) {
        logger.warn('No Traefik container found');
        return false;
      }

      const traefikContainer = containers[0];
      const ports = traefikContainer.Ports || [];

      // Check if port 27017 is exposed
      const mongoPortExposed = ports.some(port => port.PublicPort === this.portNumber);

      if (mongoPortExposed) {
        logger.debug('MongoDB port is exposed in Traefik');
        return true;
      } else {
        logger.warn('MongoDB port is not exposed in Traefik');
        return false;
      }
    } catch (err) {
      logger.error(`Error checking MongoDB port: ${err.message}`);
      return false;
    }
  }

  /**
   * Ensure MongoDB port is exposed in Traefik
   */
  async ensureMongoDBPort() {
    try {
      logger.info('Ensuring MongoDB port is exposed in Traefik');

      // Check docker-compose.yml for MongoDB port
      const dockerComposePath = await configManager.paths.docker;
      if (!dockerComposePath) {
        logger.warn('Docker compose path not found, cannot fix MongoDB port');
        return false;
      }

      // Use execAsync to check docker-compose file
      const { stdout: composeContent } = await execAsync(`cat ${dockerComposePath}`);

      // Check if port is already defined
      if (composeContent.includes(`"${this.portNumber}:${this.portNumber}"`)) {
        logger.info('MongoDB port already defined in docker-compose.yml');
        
        // Try restarting Traefik to apply configuration
        await this.restartTraefik();
        return true;
      }

      // Add MongoDB port to docker-compose.yml
      logger.info('Adding MongoDB port to docker-compose.yml');

      // Create backup
      await execAsync(`cp ${dockerComposePath} ${dockerComposePath}.bak.$(date +%s)`);

      // Try to insert port definition
      let updated = false;
      const patternAttempts = [
        // Pattern 1: Insert after ports declaration
        `sed -i 's/ports:\\([^\\]]*\\)/ports:\\1\\n      - "${this.portNumber}:${this.portNumber}"/g' ${dockerComposePath}`,
        
        // Pattern 2: Insert after another port
        `sed -i 's/"8081:8081"/"8081:8081"\\n      - "${this.portNumber}:${this.portNumber}"/g' ${dockerComposePath}`,
        
        // Pattern 3: Last resort, replace the line
        `sed -i 's/\\(ports:[^\\n]*\\)/\\1\\n      - "${this.portNumber}:${this.portNumber}"/g' ${dockerComposePath}`
      ];

      // Try each pattern until one works
      for (const cmd of patternAttempts) {
        try {
          await execAsync(cmd);
          
          // Check if the change was applied
          const { stdout: updatedContent } = await execAsync(`cat ${dockerComposePath}`);
          if (updatedContent.includes(`"${this.portNumber}:${this.portNumber}"`)) {
            updated = true;
            break;
          }
        } catch (patternErr) {
          logger.debug(`Pattern attempt failed: ${patternErr.message}`);
          // Continue to next pattern
        }
      }

      if (!updated) {
        logger.warn('Failed to update docker-compose.yml with MongoDB port');
        return false;
      }

      // Restart Docker containers to apply changes
      logger.info('Restarting containers to apply changes');
      const composeDir = dockerComposePath.substring(0, dockerComposePath.lastIndexOf('/'));
      await execAsync(`cd ${composeDir} && docker-compose up -d`);

      // Wait for containers to start
      await new Promise(resolve => setTimeout(resolve, 10000));

      // Verify port is now exposed
      return await this.checkMongoDBPort();
    } catch (err) {
      logger.error(`Error ensuring MongoDB port: ${err.message}`, {
        error: err.message,
        stack: err.stack
      });
      return false;
    }
  }

  /**
   * Ensure MongoDB entrypoint is configured in Traefik
   */
  async ensureMongoDBEntrypoint() {
    try {
      logger.info('Ensuring MongoDB entrypoint configuration');

      // Get main configuration
      await configManager.initialize();
      const config = configManager.configs.main;

      if (!config) {
        logger.warn('Main configuration not loaded, cannot configure MongoDB entrypoint');
        return false;
      }

      // Ensure TCP section exists
      if (!config.tcp) {
        config.tcp = {
          routers: {},
          services: {}
        };
      }

      // Ensure MongoDB catchall router exists
      const routerName = 'mongodb-catchall';
      const serviceName = 'mongodb-catchall-service';

      if (!config.tcp.routers?.[routerName]) {
        config.tcp.routers = config.tcp.routers || {};
        config.tcp.routers[routerName] = {
          rule: `HostSNI(\`*.${this.mongoDomain}\`)`,
          entryPoints: ['mongodb'],
          service: serviceName,
          tls: {
            passthrough: true
          }
        };
        logger.info('Added MongoDB catchall router');
      }

      // Ensure MongoDB catchall service exists
      if (!config.tcp.services?.[serviceName]) {
        config.tcp.services = config.tcp.services || {};
        config.tcp.services[serviceName] = {
          loadBalancer: {
            servers: []
          }
        };
        logger.info('Added MongoDB catchall service');
      }

      // Save configuration
      await configManager.saveConfig(configManager.paths.dynamic, config);
      
      // Restart Traefik to apply changes
      await this.restartTraefik();

      return true;
    } catch (err) {
      logger.error(`Error ensuring MongoDB entrypoint: ${err.message}`, {
        error: err.message,
        stack: err.stack
      });
      return false;
    }
  }

  /**
   * Register an agent's MongoDB instance
   * @param {string} agentId - The agent ID
   * @param {string} targetIp - The target IP address
   */
  async registerAgent(agentId, targetIp) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info(`Registering MongoDB for agent ${agentId} at ${targetIp}`);

      // Validate inputs
      if (!this.validateInputs(agentId, targetIp)) {
        throw new Error('Invalid agent ID or target IP');
      }

      // Get agent configuration
      await configManager.initialize();
      const config = await configManager.getAgentConfig(agentId);

      // Define router and service names
      const routerName = `mongodb-${agentId}`;
      const serviceName = `mongodb-${agentId}-service`;

      // Set up TCP router for this agent
      config.tcp = config.tcp || { routers: {}, services: {} };
      config.tcp.routers = config.tcp.routers || {};
      config.tcp.services = config.tcp.services || {};

      // Create router
      config.tcp.routers[routerName] = {
        rule: `HostSNI(\`${agentId}.${this.mongoDomain}\`)`,
        entryPoints: ['mongodb'],
        service: serviceName,
        tls: {
          passthrough: true
        }
      };

      // Create service
      config.tcp.services[serviceName] = {
        loadBalancer: {
          servers: [
            { address: `${targetIp}:${this.portNumber}` }
          ]
        }
      };

      // Save the configuration
      await configManager.saveAgentConfig(agentId, config);

      // Store in our registry
      this.registeredAgents.set(agentId, {
        targetIp,
        registeredAt: new Date().toISOString()
      });

      // Restart Traefik to apply changes
      await this.restartTraefik();

      // Test connectivity
      const connectionTest = await this.testConnection(agentId, targetIp);

      return {
        success: true,
        agentId,
        mongodbUrl: `${agentId}.${this.mongoDomain}`,
        targetIp,
        connectionTest
      };
    } catch (err) {
      logger.error(`Failed to register MongoDB for agent ${agentId}: ${err.message}`, {
        error: err.message,
        stack: err.stack,
        agentId,
        targetIp
      });
      throw err;
    }
  }

  /**
   * Test MongoDB connectivity
   */
  async testConnection(agentId, targetIp) {
    const results = {
      direct: await this.testDirectConnection(targetIp),
      domain: await this.testDomainConnection(agentId),
      dns: await this.checkDnsResolution(agentId)
    };

    return {
      success: results.direct || results.domain,
      results,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Test direct connection to MongoDB server
   */
  async testDirectConnection(targetIp) {
    return new Promise((resolve) => {
      logger.debug(`Testing direct connection to ${targetIp}:${this.portNumber}`);

      const socket = net.createConnection({
        host: targetIp,
        port: this.portNumber
      });

      socket.setTimeout(this.connectTimeout);

      socket.on('connect', () => {
        logger.debug(`Direct connection to ${targetIp}:${this.portNumber} successful`);
        socket.end();
        resolve(true);
      });

      socket.on('timeout', () => {
        logger.debug(`Direct connection to ${targetIp}:${this.portNumber} timed out`);
        socket.destroy();
        resolve(false);
      });

      socket.on('error', (err) => {
        logger.debug(`Direct connection to ${targetIp}:${this.portNumber} failed: ${err.message}`);
        resolve(false);
      });
    });
  }

  /**
   * Test connection through domain
   */
  async testDomainConnection(agentId) {
    return new Promise((resolve) => {
      const domain = `${agentId}.${this.mongoDomain}`;
      logger.debug(`Testing domain connection to ${domain}:${this.portNumber}`);

      const socket = net.createConnection({
        host: domain,
        port: this.portNumber
      });

      socket.setTimeout(this.connectTimeout);

      socket.on('connect', () => {
        logger.debug(`Domain connection to ${domain}:${this.portNumber} successful`);
        socket.end();
        resolve(true);
      });

      socket.on('timeout', () => {
        logger.debug(`Domain connection to ${domain}:${this.portNumber} timed out`);
        socket.destroy();
        resolve(false);
      });

      socket.on('error', (err) => {
        logger.debug(`Domain connection to ${domain}:${this.portNumber} failed: ${err.message}`);
        resolve(false);
      });
    });
  }

  /**
   * Check DNS resolution for MongoDB domain
   */
  async checkDnsResolution(agentId) {
    try {
      const domain = `${agentId}.${this.mongoDomain}`;
      logger.debug(`Checking DNS resolution for ${domain}`);

      const addresses = await dns.resolve4(domain);
      logger.debug(`DNS resolution successful for ${domain}: ${addresses.join(', ')}`);

      return {
        success: true,
        addresses,
        domain
      };
    } catch (err) {
      logger.debug(`DNS resolution failed for ${agentId}.${this.mongoDomain}: ${err.message}`);
      
      return {
        success: false,
        error: err.message,
        domain: `${agentId}.${this.mongoDomain}`
      };
    }
  }

  /**
   * List all registered MongoDB agents
   */
  async listRegisteredAgents() {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const agents = await configManager.listAgents();
      const registrations = [];

      for (const agentId of agents) {
        const config = await configManager.getAgentConfig(agentId);
        
        // Look for MongoDB routers
        if (config.tcp?.routers) {
          Object.entries(config.tcp.routers).forEach(([routerName, router]) => {
            if (routerName.startsWith('mongodb-') && router.service) {
              const serviceName = router.service;
              
              if (config.tcp.services?.[serviceName]?.loadBalancer?.servers) {
                config.tcp.services[serviceName].loadBalancer.servers.forEach(server => {
                  registrations.push({
                    agentId,
                    routerName,
                    serviceName,
                    mongoUrl: `${agentId}.${this.mongoDomain}`,
                    targetAddress: server.address
                  });
                });
              }
            }
          });
        }
      }

      return {
        success: true,
        registrations,
        count: registrations.length
      };
    } catch (err) {
      logger.error(`Failed to list registered MongoDB agents: ${err.message}`, {
        error: err.message,
        stack: err.stack
      });
      
      return {
        success: false,
        error: err.message
      };
    }
  }

  /**
   * Restart Traefik to apply configuration changes
   */
  async restartTraefik() {
    try {
      logger.info('Restarting Traefik to apply configuration changes');

      // Find the Traefik container
      const containers = await docker.listContainers({
        filters: { name: ['traefik'] }
      });

      if (containers.length === 0) {
        logger.warn('No Traefik container found, cannot restart');
        return false;
      }

      const traefikContainer = docker.getContainer(containers[0].Id);
      
      // Restart the container
      await traefikContainer.restart({ t: 10 }); // 10 seconds timeout
      
      // Wait for container to start
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      logger.info('Traefik restarted successfully');
      return true;
    } catch (err) {
      logger.error(`Failed to restart Traefik: ${err.message}`, {
        error: err.message,
        stack: err.stack
      });
      return false;
    }
  }

  /**
   * Validate registration inputs
   */
  validateInputs(agentId, targetIp) {
    // Validate agent ID (alphanumeric and hyphens)
    const validAgentId = /^[a-zA-Z0-9-]+$/.test(agentId);

    // Validate IP address
    const validIp = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(targetIp);

    if (!validAgentId) {
      logger.warn(`Invalid agent ID format: ${agentId}`);
    }

    if (!validIp) {
      logger.warn(`Invalid IP address format: ${targetIp}`);
    }

    return validAgentId && validIp;
  }