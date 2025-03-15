#!/usr/bin/env node
/**
 * Add Missing getConfig Method to ConfigManager
 *
 * This script adds the missing getConfig method to the ConfigManager class.
 */

const fs = require("fs");
const path = require("path");

// Path to the ConfigManager
const configManagerPath = path.resolve(
  __dirname,
  "../services/core/configManager.js"
);

console.log(`Adding getConfig method to ConfigManager at ${configManagerPath}`);

// Read the file
let content;
try {
  content = fs.readFileSync(configManagerPath, "utf8");
  console.log("Successfully read ConfigManager file");
} catch (err) {
  console.error(`Error reading file: ${err.message}`);
  process.exit(1);
}

// Check if getConfig method already exists
if (content.includes("getConfig(") || content.includes("getConfig (")) {
  console.log("getConfig method already exists in ConfigManager");
  process.exit(0);
}

// Find the end of the class definition
const classEndIndex = content.lastIndexOf("}");
if (classEndIndex === -1) {
  console.error("Could not find end of class definition");
  process.exit(1);
}

// Define the getConfig method
const getConfigMethod = `
  /**
   * Get configuration
   * 
   * @returns {Object} The current configuration
   */
  async getConfig() {
    if (!this.initialized) {
      await this.initialize();
    }
    
    return {
      configs: this.configs,
      paths: this.paths,
      domains: {
        app: process.env.APP_DOMAIN || "apps.cloudlunacy.uk",
        mongo: process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk",
      },
      ports: {
        node: process.env.NODE_PORT || 3005,
        traefik: 8081,
        mongo: 27017,
      },
      env: process.env.NODE_ENV || "development",
    };
  }
  
  /**
   * Get agent-specific configuration
   * 
   * @param {string} agentId - The agent ID
   * @returns {Object} Agent-specific configuration
   */
  async getAgentConfig(agentId) {
    if (!this.initialized) {
      await this.initialize();
    }
    
    // Get base configuration
    const config = await this.getConfig();
    
    // Add agent-specific configuration
    return {
      ...config,
      agentId,
      // Add any other agent-specific configuration here
    };
  }
`;

// Insert the getConfig method before the end of the class
const updatedContent =
  content.slice(0, classEndIndex) +
  getConfigMethod +
  content.slice(classEndIndex);

// Write the updated file
try {
  // Create a backup
  fs.writeFileSync(`${configManagerPath}.bak`, content);
  console.log(`Created backup at ${configManagerPath}.bak`);

  // Write the updated file
  fs.writeFileSync(configManagerPath, updatedContent);
  console.log("Successfully added getConfig method to ConfigManager");
} catch (err) {
  console.error(`Error writing file: ${err.message}`);
  process.exit(1);
}

console.log("Done!");
