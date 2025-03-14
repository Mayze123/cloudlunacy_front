#!/usr/bin/env node
/**
 * Verify MongoDB Port Exposure
 *
 * This script checks if port 27017 is properly exposed in Traefik
 * and fixes the configuration if needed.
 */

const { execSync } = require("child_process");
const fs = require("fs").promises;
const yaml = require("yaml");
const path = require("path");

// Possible docker-compose.yml locations
const COMPOSE_PATHS = [
  "./docker-compose.yml",
  "/app/docker-compose.yml",
  "/opt/cloudlunacy_front/docker-compose.yml",
  path.resolve(__dirname, "../../docker-compose.yml"),
];

async function findComposeFile() {
  for (const composePath of COMPOSE_PATHS) {
    try {
      await fs.access(composePath);
      console.log(`Found docker-compose.yml at ${composePath}`);
      return composePath;
    } catch (err) {
      // Continue to next path
    }
  }

  console.error(
    "Could not find docker-compose.yml in any of the expected locations"
  );
  return null;
}

async function checkTraefikPortConfig() {
  console.log("Checking Traefik port configuration...");

  try {
    // Check if port 27017 is exposed in running Traefik container
    const portOutput = execSync("docker port traefik | grep 27017")
      .toString()
      .trim();
    console.log(`MongoDB port is exposed: ${portOutput}`);
    return true;
  } catch (err) {
    console.log("MongoDB port 27017 is not exposed in Traefik container");

    // Try to fix docker-compose.yml
    const composePath = await findComposeFile();
    if (!composePath) {
      console.error("Cannot fix port configuration without docker-compose.yml");
      return false;
    }

    try {
      // Read and parse docker-compose.yml
      const composeContent = await fs.readFile(composePath, "utf8");
      const compose = yaml.parse(composeContent);

      // Check if Traefik service exists
      if (!compose.services || !compose.services.traefik) {
        console.error("Traefik service not found in docker-compose.yml");
        return false;
      }

      // Check if ports section exists
      if (!compose.services.traefik.ports) {
        compose.services.traefik.ports = [];
      }

      // Check if port 27017 is already mapped
      const hasPort = compose.services.traefik.ports.some((port) => {
        return (
          port === "27017:27017" || port === 27017 || port.startsWith("27017:")
        );
      });

      if (!hasPort) {
        console.log("Adding port 27017:27017 to Traefik configuration");
        compose.services.traefik.ports.push("27017:27017");

        // Create backup
        await fs.copyFile(composePath, `${composePath}.backup.${Date.now()}`);

        // Write updated configuration
        await fs.writeFile(composePath, yaml.stringify(compose), "utf8");
        console.log("Updated docker-compose.yml with MongoDB port");

        // Restart Traefik
        console.log("Restarting Traefik to apply changes...");
        try {
          execSync("docker-compose up -d traefik");
          console.log("Traefik restarted");
          return true;
        } catch (err) {
          console.error(`Failed to restart Traefik: ${err.message}`);
          console.log("You may need to restart Traefik manually");
          return false;
        }
      } else {
        console.log("Port 27017 is already configured in docker-compose.yml");
        console.log(
          "The issue might be with the Traefik container. Try restarting it."
        );
        return false;
      }
    } catch (err) {
      console.error(`Error updating docker-compose.yml: ${err.message}`);
      return false;
    }
  }
}

// Run the check
checkTraefikPortConfig().then((result) => {
  if (result) {
    console.log("MongoDB port configuration is correct");
  } else {
    console.error("Failed to verify or fix MongoDB port configuration");
  }
});
