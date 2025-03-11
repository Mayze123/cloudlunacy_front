#!/usr/bin/env node
/**
 * Startup Configuration Check
 *
 * This script performs configuration validation and fixes at startup.
 * It should be run before starting the front server to ensure all
 * configurations are valid.
 */

const fs = require("fs").promises;
const path = require("path");
const yaml = require("yaml");
const { promisify } = require("util");
const exec = promisify(require("child_process").exec);

console.log("===================================================");
console.log("CloudLunacy Front Server - Startup Configuration Check");
console.log("===================================================");

// Configuration paths
const CONFIG_PATHS = [
  "/etc/traefik/dynamic.yml", // Container path
  "/opt/cloudlunacy_front/config/dynamic.yml", // Host path
  "config/dynamic.yml", // Relative path
];

// Corrected configuration template
const CORRECT_CONFIG = {
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
    routers: {
      "mongodb-catchall": {
        rule: "HostSNI(`*.mongodb.cloudlunacy.uk`)",
        entryPoints: ["mongodb"],
        service: "mongodb-catchall-service",
        tls: {
          passthrough: true,
        },
      },
    },
    services: {
      "mongodb-catchall-service": {
        loadBalancer: {
          servers: [],
        },
      },
    },
  },
};

/**
 * Attempt to read and parse YAML file
 */
async function readYamlFile(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    try {
      return { success: true, data: yaml.parse(content), original: content };
    } catch (parseErr) {
      console.error(`Error parsing YAML file ${filePath}:`, parseErr.message);
      return { success: false, error: parseErr.message, original: content };
    }
  } catch (readErr) {
    console.error(`Error reading file ${filePath}:`, readErr.message);
    return { success: false, error: readErr.message };
  }
}

/**
 * Backup file before modifying
 */
async function backupFile(filePath) {
  try {
    const backupPath = `${filePath}.backup.${Date.now()}`;
    await fs.copyFile(filePath, backupPath);
    console.log(`Created backup at ${backupPath}`);
    return true;
  } catch (err) {
    console.error(`Failed to create backup of ${filePath}:`, err.message);
    return false;
  }
}

/**
 * Write corrected YAML file
 */
async function writeYamlFile(filePath, data) {
  try {
    // Format with proper indentation
    const yamlStr = yaml.stringify(data, {
      indent: 2,
      aliasDuplicateObjects: false,
    });
    await fs.writeFile(filePath, yamlStr, "utf8");
    console.log(`Successfully wrote corrected configuration to ${filePath}`);
    return true;
  } catch (err) {
    console.error(`Failed to write configuration to ${filePath}:`, err.message);
    return false;
  }
}

/**
 * Compare original config with corrected config
 */
function compareConfigs(original, corrected) {
  const differences = [];

  // Check for missing top-level sections
  for (const section of ["http", "tcp"]) {
    if (!original[section]) {
      differences.push(`Missing ${section} section`);
    } else {
      // Check for missing subsections
      for (const subsection of ["routers", "services", "middlewares"]) {
        if (section === "http" && !original[section][subsection]) {
          differences.push(`Missing ${section}.${subsection} section`);
        } else if (
          section === "tcp" &&
          subsection !== "middlewares" &&
          !original[section][subsection]
        ) {
          differences.push(`Missing ${section}.${subsection} section`);
        }
      }
    }
  }

  // Check for MongoDB catchall router
  if (!original.tcp?.routers?.["mongodb-catchall"]) {
    differences.push("Missing mongodb-catchall router");
  }

  return differences;
}

/**
 * Merge existing configuration with corrected template
 */
function mergeConfigurations(existing, template) {
  // Create a deep copy of the template
  const result = JSON.parse(JSON.stringify(template));

  try {
    // If existing config is valid, try to preserve custom routers and services
    if (existing.http && existing.http.routers) {
      // Preserve existing HTTP routers (except overwrite dashboard)
      for (const [key, value] of Object.entries(existing.http.routers)) {
        if (key !== "dashboard") {
          result.http.routers[key] = value;
        }
      }

      // Preserve existing HTTP services
      if (existing.http.services) {
        for (const [key, value] of Object.entries(existing.http.services)) {
          result.http.services[key] = value;
        }
      }

      // Preserve existing HTTP middlewares (except overwrite auth and web-to-websecure)
      if (existing.http.middlewares) {
        for (const [key, value] of Object.entries(existing.http.middlewares)) {
          if (key !== "auth" && key !== "web-to-websecure") {
            result.http.middlewares[key] = value;
          }
        }
      }
    }

    // Preserve existing TCP routers (except overwrite mongodb-catchall)
    if (existing.tcp && existing.tcp.routers) {
      for (const [key, value] of Object.entries(existing.tcp.routers)) {
        if (key !== "mongodb-catchall") {
          result.tcp.routers[key] = value;
        }
      }

      // Preserve existing TCP services (except the catchall)
      if (existing.tcp.services) {
        for (const [key, value] of Object.entries(existing.tcp.services)) {
          if (key !== "mongodb-catchall-service") {
            result.tcp.services[key] = value;
          }
        }
      }
    }

    return result;
  } catch (err) {
    console.error("Error merging configurations:", err.message);
    return template; // Return template as fallback
  }
}

/**
 * Check if Traefik is running
 */
async function checkTraefikRunning() {
  try {
    const { stdout } = await exec("docker ps | grep traefik");
    if (stdout) {
      console.log("✅ Traefik container is running");
      return true;
    } else {
      console.error("❌ Traefik container is not running");
      return false;
    }
  } catch (err) {
    console.error("❌ Error checking Traefik container:", err.message);
    return false;
  }
}

/**
 * Check if MongoDB port is exposed
 */
async function checkMongoDBPort() {
  try {
    const { stdout } = await exec('docker ps | grep -E "traefik.*27017"');
    if (stdout) {
      console.log("✅ MongoDB port 27017 is exposed in Traefik");
      return true;
    } else {
      console.error("❌ MongoDB port 27017 is not exposed in Traefik");
      return false;
    }
  } catch (err) {
    console.error("❌ Error checking MongoDB port:", err.message);
    return false;
  }
}

/**
 * Check docker-compose.yml for MongoDB port
 */
async function checkDockerCompose() {
  try {
    // Find docker-compose.yml
    const dockerComposeLocations = [
      "/opt/cloudlunacy_front/docker-compose.yml",
      "./docker-compose.yml",
    ];

    let dockerComposePath;
    for (const location of dockerComposeLocations) {
      try {
        await fs.access(location);
        dockerComposePath = location;
        break;
      } catch (err) {
        // Continue to next location
      }
    }

    if (!dockerComposePath) {
      console.error("❌ Could not find docker-compose.yml file");
      return false;
    }

    console.log(`Found docker-compose.yml at ${dockerComposePath}`);

    // Read docker-compose.yml
    const content = await fs.readFile(dockerComposePath, "utf8");

    // Check if MongoDB port is defined
    if (content.includes('"27017:27017"')) {
      console.log("✅ MongoDB port 27017 is defined in docker-compose.yml");
      return true;
    } else {
      console.error(
        "❌ MongoDB port 27017 is not defined in docker-compose.yml"
      );
      return false;
    }
  } catch (err) {
    console.error("❌ Error checking docker-compose.yml:", err.message);
    return false;
  }
}

/**
 * Fix docker-compose.yml
 */
async function fixDockerCompose() {
  try {
    // Find docker-compose.yml
    const dockerComposeLocations = [
      "/opt/cloudlunacy_front/docker-compose.yml",
      "./docker-compose.yml",
    ];

    let dockerComposePath;
    for (const location of dockerComposeLocations) {
      try {
        await fs.access(location);
        dockerComposePath = location;
        break;
      } catch (err) {
        // Continue to next location
      }
    }

    if (!dockerComposePath) {
      console.error("❌ Could not find docker-compose.yml file");
      return false;
    }

    // Read docker-compose.yml
    const content = await fs.readFile(dockerComposePath, "utf8");

    // Check if MongoDB port is defined
    if (content.includes('"27017:27017"')) {
      console.log(
        "✅ MongoDB port 27017 is already defined in docker-compose.yml"
      );
      return true;
    }

    // Create backup
    await backupFile(dockerComposePath);

    // Add MongoDB port
    let updatedContent = content;

    // Try different patterns for insertion
    const patterns = [
      {
        regex: /ports:([^\]]*?)(\s+-)(\s+)"8081:8081"/s,
        replacement: 'ports:$1$2$3"8081:8081"$2$3"27017:27017"',
      },
      {
        regex: /(ports:\s*(?:-\s+[^\s]+\s+)+)/s,
        replacement: '$1- "27017:27017"\n      ',
      },
      {
        regex: /(ports:.*?)\n/s,
        replacement: '$1\n      - "27017:27017"\n',
      },
    ];

    for (const pattern of patterns) {
      const testContent = updatedContent.replace(
        pattern.regex,
        pattern.replacement
      );
      if (testContent !== updatedContent) {
        updatedContent = testContent;
        break;
      }
    }

    // Check if any pattern matched
    if (updatedContent === content) {
      console.error(
        "❌ Could not modify docker-compose.yml - no matching patterns"
      );
      return false;
    }

    // Write updated content
    await fs.writeFile(dockerComposePath, updatedContent, "utf8");
    console.log("✅ Added MongoDB port 27017 to docker-compose.yml");

    return true;
  } catch (err) {
    console.error("❌ Error fixing docker-compose.yml:", err.message);
    return false;
  }
}

/**
 * Fix dynamic configuration
 */
async function fixTraefikConfig() {
  console.log("Checking Traefik dynamic configuration...");

  let fixedAny = false;

  for (const configPath of CONFIG_PATHS) {
    console.log(`Checking configuration at ${configPath}...`);

    // Try to read the file
    const result = await readYamlFile(configPath);

    if (!result.success) {
      console.log(`Skipping ${configPath} due to read error...`);
      continue;
    }

    // Compare with the correct structure
    const differences = compareConfigs(result.data, CORRECT_CONFIG);

    if (differences.length > 0) {
      console.log(`Found ${differences.length} issues with ${configPath}:`);
      differences.forEach((diff) => console.log(`- ${diff}`));

      // Create backup
      await backupFile(configPath);

      // Merge configurations to preserve custom settings
      const mergedConfig = mergeConfigurations(result.data, CORRECT_CONFIG);

      // Write the corrected configuration
      const writeResult = await writeYamlFile(configPath, mergedConfig);

      if (writeResult) {
        fixedAny = true;
        console.log(`✅ Successfully repaired ${configPath}`);
      }
    } else {
      console.log(`✅ No issues found with ${configPath}`);
    }
  }

  return fixedAny;
}

/**
 * Restart Traefik container
 */
async function restartTraefik() {
  try {
    console.log("Restarting Traefik container...");
    await exec("docker restart traefik");
    console.log("✅ Traefik container restarted successfully");

    // Wait for container to start
    console.log("Waiting for Traefik to start...");
    await new Promise((resolve) => setTimeout(resolve, 5000));

    return true;
  } catch (err) {
    console.error("❌ Error restarting Traefik container:", err.message);
    return false;
  }
}

/**
 * Check all agents directories
 */
async function checkAgentsDirectories() {
  const agentDirs = [
    "/etc/traefik/agents",
    "/opt/cloudlunacy_front/config/agents",
  ];

  for (const dir of agentDirs) {
    try {
      await fs.access(dir);
      console.log(`✅ Agents directory exists at ${dir}`);

      // Check if directory is empty
      const files = await fs.readdir(dir);
      if (files.length === 0) {
        console.log(`Directory ${dir} is empty, creating test agent...`);

        // Create a default agent config
        const testAgent = {
          http: { routers: {}, services: {}, middlewares: {} },
          tcp: { routers: {}, services: {} },
        };

        await writeYamlFile(path.join(dir, "default.yml"), testAgent);
      }
    } catch (err) {
      console.log(`Creating agents directory at ${dir}...`);

      try {
        await fs.mkdir(dir, { recursive: true });
        console.log(`✅ Created agents directory at ${dir}`);

        // Create a default agent config
        const testAgent = {
          http: { routers: {}, services: {}, middlewares: {} },
          tcp: { routers: {}, services: {} },
        };

        await writeYamlFile(path.join(dir, "default.yml"), testAgent);
      } catch (mkdirErr) {
        console.error(
          `❌ Error creating agents directory at ${dir}:`,
          mkdirErr.message
        );
      }
    }
  }
}

/**
 * Main function
 */
async function main() {
  console.log("Starting configuration check...");

  // Check if Traefik is running
  const traefikRunning = await checkTraefikRunning();

  // Check if MongoDB port is exposed
  const mongoDBPortExposed = await checkMongoDBPort();

  // Check docker-compose.yml
  const dockerComposeOk = await checkDockerCompose();

  // Fix configurations if needed
  let needsRestart = false;

  // Fix docker-compose.yml if needed
  if (!dockerComposeOk) {
    const fixed = await fixDockerCompose();
    if (fixed) {
      needsRestart = true;
    }
  }

  // Fix Traefik configuration
  const configFixed = await fixTraefikConfig();
  if (configFixed) {
    needsRestart = true;
  }

  // Check agents directories
  await checkAgentsDirectories();

  // Restart Traefik if needed
  if (needsRestart && traefikRunning) {
    await restartTraefik();

    // Check if MongoDB port is now exposed
    const mongoDBPortExposedAfterRestart = await checkMongoDBPort();
    if (!mongoDBPortExposedAfterRestart) {
      console.warn(
        "⚠️ MongoDB port 27017 is still not exposed in Traefik after restart"
      );
      console.warn(
        "⚠️ You may need to recreate the Traefik container with the correct port mapping"
      );
    }
  }

  console.log("===================================================");
  console.log("Configuration check completed.");
  console.log("===================================================");
}

// Run the main function
main().catch((err) => {
  console.error("Error during startup check:", err);
  process.exit(1);
});
