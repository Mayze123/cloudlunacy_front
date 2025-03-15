/**
 * Validate the Traefik configuration
 * 
 * @param {object} config - The configuration to validate
 * @returns {boolean} - Whether the configuration is valid
 */
validateConfig(config) {
  // Check if the config has the required sections
  if (!config) {
    logger.error('Configuration is null or undefined');
    return false;
  }
  
  // Ensure tcp section exists
  if (!config.tcp) {
    logger.warn('TCP section missing from configuration, adding it');
    config.tcp = { routers: {}, services: {} };
  }
  
  if (!config.tcp.routers) {
    logger.warn('TCP routers section missing from configuration, adding it');
    config.tcp.routers = {};
  }
  
  if (!config.tcp.services) {
    logger.warn('TCP services section missing from configuration, adding it');
    config.tcp.services = {};
  }
  
  // Check MongoDB services to ensure they have servers
  for (const [serviceName, service] of Object.entries(config.tcp.services)) {
    if (serviceName.startsWith('mongodb-') && serviceName.endsWith('-service')) {
      if (!service.loadBalancer) {
        logger.warn(`Service ${serviceName} is missing loadBalancer, adding it`);
        service.loadBalancer = { servers: [] };
      }
      
      if (!service.loadBalancer.servers || !Array.isArray(service.loadBalancer.servers)) {
        logger.warn(`Service ${serviceName} is missing servers array, adding it`);
        service.loadBalancer.servers = [];
      }
      
      // Check if the service has any servers
      if (service.loadBalancer.servers.length === 0) {
        logger.warn(`Service ${serviceName} has no servers`);
        // We don't add servers here as we don't know the IP
      }
    }
  }
  
  return true;
}

/**
 * Save the Traefik configuration
 * 
 * @param {object} config - The configuration to save
 * @returns {Promise<void>}
 */
async saveConfig(config) {
  try {
    // Validate the configuration before saving
    this.validateConfig(config);
    
    // Convert to YAML and save
    const yamlContent = yaml.stringify(config);
    await fs.writeFile(this.configPath, yamlContent, 'utf8');
    logger.info(`Configuration saved to ${this.configPath}`);
  } catch (err) {
    logger.error(`Failed to save configuration: ${err.message}`, {
      error: err.message,
      stack: err.stack
    });
    throw err;
  }
} 