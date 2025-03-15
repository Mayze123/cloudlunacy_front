#!/usr/bin/env node
/**
 * Add Missing Methods to ConfigManager
 *
 * This script adds missing methods to the ConfigManager class:
 * - getStaticConfig
 * - updateStaticConfig
 * - updateDockerCompose
 */

const fs = require("fs");
const path = require("path");

// Path to the ConfigManager
const configManagerPath = path.resolve(
  __dirname,
  "../services/core/configManager.js"
);

console.log(`Adding missing methods to ConfigManager at ${configManagerPath}`);

// Read the file
let content;
try {
  content = fs.readFileSync(configManagerPath, "utf8");
  console.log("Successfully read ConfigManager file");
} catch (err) {
  console.error(`Error reading file: ${err.message}`);
  process.exit(1);
}

// Find the end of the class definition
const classEndIndex = content.lastIndexOf("}");
if (classEndIndex === -1) {
  console.error("Could not find end of class definition");
  process.exit(1);
}

// Define the missing methods
const missingMethods = `
  /**
   * Get Traefik static configuration
   *
   * @returns {Promise<Object>} The static configuration
   */
  async getStaticConfig() {
    const staticConfigPath = process.env.STATIC_CONFIG_PATH || "/etc/traefik/traefik.yml";
    
    try {
      logger.info(\`Loading static configuration from \${staticConfigPath}\`);
      
      // Read and parse the configuration
      const content = await fs.readFile(staticConfigPath, "utf8");
      return yaml.parse(content) || {};
    } catch (err) {
      logger.error(\`Failed to load static configuration: \${err.message}\`, {
        error: err.message,
        stack: err.stack,
      });
      return {};
    }
  }
  
  /**
   * Update Traefik static configuration
   *
   * @param {Object} config - The updated configuration
   * @returns {Promise<boolean>} Success status
   */
  async updateStaticConfig(config) {
    const staticConfigPath = process.env.STATIC_CONFIG_PATH || "/etc/traefik/traefik.yml";
    
    try {
      logger.info(\`Updating static configuration at \${staticConfigPath}\`);
      
      // Create a backup
      const backupPath = \`\${staticConfigPath}.bak\`;
      try {
        const originalContent = await fs.readFile(staticConfigPath, "utf8");
        await fs.writeFile(backupPath, originalContent, "utf8");
        logger.info(\`Created backup at \${backupPath}\`);
      } catch (_backupErr) {
        logger.warn(\`Failed to create backup of static configuration\`);
      }
      
      // Convert to YAML and save
      const yamlContent = yaml.stringify(config);
      await fs.writeFile(staticConfigPath, yamlContent, "utf8");
      logger.info(\`Static configuration updated at \${staticConfigPath}\`);
      
      return true;
    } catch (err) {
      logger.error(\`Failed to update static configuration: \${err.message}\`, {
        error: err.message,
        stack: err.stack,
      });
      return false;
    }
  }
  
  /**
   * Update Docker Compose configuration
   *
   * @param {Function} updateFn - Function to update the compose configuration
   * @returns {Promise<boolean>} Success status
   */
  async updateDockerCompose(updateFn) {
    const composeConfigPath = process.env.DOCKER_COMPOSE_PATH || "/app/docker-compose.yml";
    
    try {
      logger.info(\`Updating Docker Compose configuration at \${composeConfigPath}\`);
      
      // Read and parse the configuration
      const content = await fs.readFile(composeConfigPath, "utf8");
      const compose = yaml.parse(content) || {};
      
      // Apply the update function
      const updated = updateFn(compose);
      
      if (updated) {
        // Create a backup
        const backupPath = \`\${composeConfigPath}.bak\`;
        try {
          await fs.writeFile(backupPath, content, "utf8");
          logger.info(\`Created backup at \${backupPath}\`);
        } catch (_err) {
          logger.warn(\`Failed to create backup of Docker Compose configuration\`);
        }
        
        // Convert to YAML and save
        const yamlContent = yaml.stringify(compose);
        await fs.writeFile(composeConfigPath, yamlContent, "utf8");
        logger.info(\`Docker Compose configuration updated at \${composeConfigPath}\`);
      } else {
        logger.info(\`No changes needed for Docker Compose configuration\`);
      }
      
      return updated;
    } catch (err) {
      logger.error(\`Failed to update Docker Compose configuration: \${err.message}\`, {
        error: err.message,
        stack: err.stack,
      });
      return false;
    }
  }
`;

// Check if methods already exist
const methodsToCheck = [
  "getStaticConfig",
  "updateStaticConfig",
  "updateDockerCompose",
];

let methodsToAdd = missingMethods;
let methodsFound = [];

for (const method of methodsToCheck) {
  if (content.includes(`${method}(`) || content.includes(`${method} (`)) {
    methodsFound.push(method);
  }
}

if (methodsFound.length > 0) {
  console.log(
    `The following methods already exist: ${methodsFound.join(", ")}`
  );
}

if (methodsFound.length === methodsToCheck.length) {
  console.log("All methods already exist in ConfigManager");
  process.exit(0);
}

// Insert the missing methods before the end of the class
const updatedContent =
  content.slice(0, classEndIndex) + methodsToAdd + content.slice(classEndIndex);

// Write the updated file
try {
  // Create a backup
  fs.writeFileSync(`${configManagerPath}.bak`, content);
  console.log(`Created backup at ${configManagerPath}.bak`);

  // Write the updated file
  fs.writeFileSync(configManagerPath, updatedContent);
  console.log("Successfully added missing methods to ConfigManager");
} catch (err) {
  console.error(`Error writing file: ${err.message}`);
  process.exit(1);
}

console.log("Done!");
