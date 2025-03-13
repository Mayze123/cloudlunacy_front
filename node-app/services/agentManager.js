// services/agentManager.js
/**
 * Agent Manager
 * 
 * Handles agent registration, authentication, and communication
 */

const jwt = require('jsonwebtoken');
const configManager = require('./configManager');
const mongodbManager = require('./mongodbManager');
const logger = require('../utils/logger').getLogger('agentManager');

class AgentManager {
  constructor() {
    this.jwtSecret = process.env.JWT_SECRET;
    if (!this.jwtSecret) {
      logger.warn('JWT_SECRET environment variable is not set. Agent authentication will not work properly.');
    }

    this.registeredAgents = new Map();
    this.initialized = false;
  }

  /**
   * Initialize the agent manager
   */
  async initialize() {
    if (this.initialized) {
      return true;
    }

    try {
      logger.info('Initializing agent manager');

      // Load registered agents
      await configManager.initialize();
      const agentIds = await configManager.listAgents();
      
      for (const agentId of agentIds) {
        this.registeredAgents.set(agentId, {
          registeredAt: new Date().toISOString()
        });
      }

      logger.info(`Loaded ${this.registeredAgents.size} registered agents`);
      this.initialized = true;
      return true;
    } catch (err) {
      logger.error(`Failed to initialize agent manager: ${err.message}`, {
        error: err.message,
        stack: err.stack
      });
      throw err;
    }
  }

  /**
   * Register a new agent
   */
  async registerAgent(agentId, targetIp) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info(`Registering agent ${agentId} with IP ${targetIp}`);

      // Validate inputs
      if (!this.validateInputs(agentId, targetIp)) {
        throw new Error('Invalid agent ID or target IP');
      }

      // Generate JWT token for agent authentication
      const token = this.generateAgentToken(agentId);

      // Register MongoDB for the agent
      const mongodbResult = await mongodbManager.registerAgent(agentId, targetIp);

      // Get the agent configuration or create if it doesn't exist
      const config = await configManager.getAgentConfig(agentId);

      // Save agent registration info
      this.registeredAgents.set(agentId, {
        targetIp,
        registeredAt: new Date().toISOString(),
        lastSeen: new Date().toISOString()
      });

      // Save the agent configuration
      await configManager.saveAgentConfig(agentId, config);

      return {
        success: true,
        agentId,
        token,
        mongodbUrl: mongodbResult.mongodbUrl,
        targetIp,
        registeredAt: new Date().toISOString()
      };
    } catch (err) {
      logger.error(`Failed to register agent ${agentId}: ${err.message}`, {
        error: err.message,
        stack: err.stack,
        agentId,
        targetIp
      });
      throw err;
    }
  }

  /**
   * Generate JWT token for agent authentication
   */
  generateAgentToken(agentId) {
    if (!this.jwtSecret) {
      throw new Error('JWT_SECRET is not configured');
    }

    const payload = {
      agentId,
      role: 'agent',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60 // 30 days
    };

    return jwt.sign(payload, this.jwtSecret);
  }

  /**
   * Verify JWT token and extract agent information
   */
  verifyAgentToken(token) {
    if (!this.jwtSecret) {
      throw new Error('JWT_SECRET is not configured');
    }

    try {
      const decoded = jwt.verify(token, this.jwtSecret);
      
      // Update last seen timestamp
      if (this.registeredAgents.has(decoded.agentId)) {
        this.registeredAgents.get(decoded.agentId).lastSeen = new Date().toISOString();
      }
      
      return decoded;
    } catch (err) {
      logger.warn(`Invalid token: ${err.message}`);
      throw new Error(`Invalid token: ${err.message}`);
    }
  }

  /**
   * Register a new app for an agent
   */
  async registerApp(agentId, appData) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      logger.info(`Registering app for agent ${agentId}`, { appData });

      // Check if agent is registered
      if (!this.registeredAgents.has(agentId)) {
        throw new Error(`Agent ${agentId} is not registered`);
      }

      const { subdomain, targetUrl, protocol = 'http' } = appData;

      // Validate inputs
      if (!this.validateAppInputs(subdomain, targetUrl)) {
        throw new Error('Invalid subdomain or target URL');
      }

      // Get agent configuration
      const config = await configManager.getAgentConfig(agentId);

      // Extract targetHost from URL for host header
      let targetHost;
      try {
        const url = new URL(targetUrl.startsWith(protocol) ? targetUrl : `${protocol}://${targetUrl}`);
        targetHost = url.host; // hostname:port
      } catch (err) {
        logger.warn(`Failed to parse URL ${targetUrl}: ${err.message}`);
        targetHost = targetUrl;
      }

      // Define names
      const appDomain = process.env.APP_DOMAIN || 'apps.cloudlunacy.uk';
      const middlewareName = `${subdomain}-host-rewrite`;
      
      // Set up HTTP router for the app
      config.http = config.http || { routers: {}, services: {}, middlewares: {} };
      config.http.routers = config.http.routers || {};
      config.http.services = config.http.services || {};
      config.http.middlewares = config.http.middlewares || {};

      // Create middleware for host rewriting
      config.http.middlewares[middlewareName] = {
        headers: {
          customRequestHeaders: {
            Host: targetHost
          }
        }
      };

      // Create router
      config.http.routers[subdomain] = {
        rule: `Host(\`${subdomain}.${appDomain}\`)`,
        service: `${subdomain}-service`,
        entryPoints: ['web', 'websecure'],
        middlewares: [middlewareName],
        tls: {
          certResolver: 'letsencrypt'
        }
      };

      // Create service
      config.http.services[`${subdomain}-service`] = {
        loadBalancer: {
          servers: [
            { url: targetUrl.startsWith(protocol) ? targetUrl : `${protocol}://${targetUrl}` }
          ]
        }
      };

      // Save the configuration
      await configManager.saveAgentConfig(agentId, config);

      // Restart Traefik to apply changes
      await mongodbManager.restartTraefik();

      return {
        success: true,
        agentId,
        subdomain,
        domain: `${subdomain}.${appDomain}`,
        targetUrl: targetUrl.startsWith(protocol) ? targetUrl : `${protocol}://${targetUrl}`
      };
    } catch (err) {
      logger.error(`Failed to register app for agent ${agentId}: ${err.message}`, {
        error: err.message,
        stack: err.stack,
        agentId,
        appData
      });
      throw err;
    }
  }

  /**
   * List all registered agents
   */
  async listAgents() {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const agentIds = Array.from(this.registeredAgents.keys());
      const details = [];

      for (const agentId of agentIds) {
        const agentInfo = this.registeredAgents.get(agentId);
        const config = await configManager.getAgentConfig(agentId);
        
        // Count apps
        const appCount = config.http?.routers ? Object.keys(config.http.routers).length : 0;
        
        // Count MongoDB connections
        const mongoCount = config.tcp?.routers ? 
          Object.keys(config.tcp.routers).filter(name => name.startsWith('mongodb-')).length : 0;

        details.push({
          agentId,
          registeredAt: agentInfo.registeredAt,
          lastSeen: agentInfo.lastSeen || agentInfo.registeredAt,
          targetIp: agentInfo.targetIp,
          appCount,
          mongoCount
        });
      }

      return {
        success: true,
        agents: details,
        count: details.length
      };
    } catch (err) {
      logger.error(`Failed to list agents: ${err.message}`, {
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
   * Get agent details
   */
  async getAgentDetails(agentId) {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // Check if agent exists
      if (!this.registeredAgents.has(agentId)) {
        throw new Error(`Agent ${agentId} not found`);
      }

      const agentInfo = this.registeredAgents.get(agentId);
      const config = await configManager.getAgentConfig(agentId);
      
      // Get apps
      const apps = [];
      if (config.http?.routers) {
        for (const [name, router] of Object.entries(config.http.routers)) {
          if (router.service && config.http.services?.[router.service]) {
            const service = config.http.services[router.service];
            const appDomain = process.env.APP_DOMAIN || 'apps.cloudlunacy.uk';
            
            apps.push({
              name,
              domain: `${name}.${appDomain}`,
              targetUrl: service.loadBalancer?.servers?.[0]?.url || 'unknown'
            });
          }
        }
      }
      
      // Get MongoDB connections
      const mongoConnections = [];
      if (config.tcp?.routers) {
        for (const [name, router] of Object.entries(config.tcp.routers)) {
          if (name.startsWith('mongodb-') && router.service && config.tcp.services?.[router.service]) {
            const service = config.tcp.services[router.service];
            const mongoDomain = process.env.MONGO_DOMAIN || 'mongodb.cloudlunacy.uk';
            
            mongoConnections.push({
              name,
              domain: `${agentId}.${mongoDomain}`,
              targetAddress: service.loadBalancer?.servers?.[0]?.address || 'unknown'
            });
          }
        }
      }
      
      return {
        success: true,
        agentId,
        details: {
          ...agentInfo,
          apps,
          mongoConnections
        }
      };
    } catch (err) {
      logger.error(`Failed to get agent details for ${agentId}: ${err.message}`, {
        error: err.message,
        stack: err.stack,
        agentId
      });
      
      return {
        success: false,
        error: err.message
      };
    }
  }

  /**
   * Deregister an agent
   */
  async deregisterAgent(agentId) {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // Check if agent exists
      if (!this.registeredAgents.has(agentId)) {
        throw new Error(`Agent ${agentId} not found`);
      }

      // Remove agent configuration
      await configManager.removeAgentConfig(agentId);
      
      // Remove from registered agents
      this.registeredAgents.delete(agentId);
      
      // Restart Traefik to apply changes
      await mongodbManager.restartTraefik();

      return {
        success: true,
        agentId,
        message: `Agent ${agentId} deregistered successfully`
      };
    } catch (err) {
      logger.error(`Failed to deregister agent ${agentId}: ${err.message}`, {
        error: err.message,
        stack: err.stack,
        agentId
      });
      
      return {
        success: false,
        error: err.message
      };
    }
  }

  /**
   * Validate agent registration inputs
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

  /**
   * Validate app registration inputs
   */
  validateAppInputs(subdomain, targetUrl) {
    // Validate subdomain (alphanumeric and hyphens)
    const validSubdomain = /^[a-z0-9-]+$/.test(subdomain);

    // Validate target URL
    const validUrl = /^(?:https?:\/\/)?[a-zA-Z0-9.-]+(?::\d+)?(?:\/.*)?$/.test(targetUrl);

    if (!validSubdomain) {
      logger.warn(`Invalid subdomain format: ${subdomain}`);
    }

    if (!validUrl) {
      logger.warn(`Invalid target URL format: ${targetUrl}`);
    }

    return validSubdomain && validUrl;
  }