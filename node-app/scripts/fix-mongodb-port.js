#!/usr/bin/env node
/**
 * Fix MongoDB Port Exposure
 *
 * This script ensures that port 27017 is properly exposed in Traefik
 */

const { execSync } = require("child_process");
const fs = require("fs").promises;
const yaml = require("yaml");
const path = require("path");

// Configuration
const DOCKER_COMPOSE_PATHS = [
  "/opt/cloudlunacy_front/docker-compose.yml",
  "./docker-compose.yml",
  "../docker-compose.yml",
];

async function fixDockerCompose() {
  console.log("Checking Docker Compose configuration...");

  // Find docker-compose.yml
  let composePath = null;
  let composeContent = null;

  for (const path of DOCKER_COMPOSE_PATHS) {
    try {
      composeContent = await fs.readFile(path, "utf8");
      composePath = path;
      console.log(`Found docker-compose.yml at ${path}`);
      break;
    } catch (err) {
      // Continue to next path
    }
  }

  if (!composePath) {
    console.error("Could not find docker-compose.yml");
    return false;
  }

  // Parse YAML
  const compose = yaml.parse(composeContent);

  // Check if port 27017 is exposed in Traefik
  let modified = false;

  if (
    compose.services &&
    compose.services.traefik &&
    compose.services.traefik.ports
  ) {
    const ports = compose.services.traefik.ports;
    const hasMongoPort = ports.some((port) => port.includes("27017:27017"));

    if (!hasMongoPort) {
      console.log("Adding MongoDB port 27017 to Traefik configuration");
      ports.push("27017:27017");
      modified = true;
    } else {
      console.log("MongoDB port 27017 is already exposed in Traefik");
    }
  }

  // Save changes if modified
  if (modified) {
    // Create backup
    await fs.writeFile(`${composePath}.bak`, composeContent);
    console.log(`Created backup at ${composePath}.bak`);

    // Write updated file
    const updatedContent = yaml.stringify(compose);
    await fs.writeFile(composePath, updatedContent);
    console.log(`Updated ${composePath}`);

    // Restart Traefik
    console.log("Restarting Traefik container...");
    execSync("docker restart traefik");
    console.log("Traefik restarted");

    return true;
  }

  return false;
}

// Main function
async function main() {
  console.log("Starting MongoDB port fix...");

  // Check if port is already exposed
  try {
    const portCheck = execSync("docker port traefik | grep 27017").toString();
    if (portCheck) {
      console.log("MongoDB port 27017 is already exposed in Traefik container");
      return;
    }
  } catch (err) {
    console.log("MongoDB port 27017 is not exposed in Traefik container");
  }

  // Fix docker-compose.yml
  const fixed = await fixDockerCompose();

  if (fixed) {
    console.log("MongoDB port configuration has been fixed");
  } else {
    console.log("No changes were needed or could not fix the configuration");
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
