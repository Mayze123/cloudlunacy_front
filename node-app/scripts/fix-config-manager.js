#!/usr/bin/env node
/**
 * Fix ConfigManager Issues
 *
 * This script adds missing methods to the ConfigManager
 */

const fs = require("fs");
const path = require("path");

// Path to the ConfigManager
const configManagerPath = path.resolve(
  __dirname,
  "../services/core/configManager.js"
);

console.log(`Fixing ConfigManager at ${configManagerPath}`);

// Read the file
let content;
try {
  content = fs.readFileSync(configManagerPath, "utf8");
  console.log("Successfully read ConfigManager file");
} catch (err) {
  console.error(`Error reading file: ${err.message}`);
  process.exit(1);
}

// Check if getConfig method exists
if (!content.includes("async getConfig(")) {
  console.log("Adding getConfig method to ConfigManager");

  // Find the class closing brace
  const classEndIndex = content.lastIndexOf("}\n\nmodule.exports");

  if (classEndIndex === -1) {
    console.error("Could not find class end");
    process.exit(1);
  }

  // Add getConfig method
  const getConfigMethod = `
  /**
   * Get configuration by name
   * 
   * @param {string} name - Configuration name
   * @returns {Promise<Object>} - Configuration object
   */
  async getConfig(name) {
    if (!this.initialized) {
      await this.initialize();
    }
    
    if (name === 'main') {
      return this.configs.main || {};
    }
    
    return this.configs[name] || {};
  }
`;

  // Insert the method before the class end
  content =
    content.slice(0, classEndIndex) +
    getConfigMethod +
    content.slice(classEndIndex);

  // Write the updated file
  try {
    // Create a backup
    fs.writeFileSync(
      `${configManagerPath}.bak`,
      fs.readFileSync(configManagerPath)
    );
    console.log(`Created backup at ${configManagerPath}.bak`);

    // Write the updated file
    fs.writeFileSync(configManagerPath, content);
    console.log("Successfully added getConfig method to ConfigManager");
  } catch (err) {
    console.error(`Error writing file: ${err.message}`);
    process.exit(1);
  }
} else {
  console.log("getConfig method already exists in ConfigManager");
}

console.log("ConfigManager fix completed");
