// fix-traefik-config.js
//
// This script fixes malformed Traefik configuration files
// Run with: node fix-traefik-config.js

const fs = require("fs").promises;
const path = require("path");
const yaml = require("yaml");

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
 * Main function to fix Traefik configuration
 */
async function fixTraefikConfig() {
  console.log("Starting Traefik configuration repair...");

  let fixedAny = false;

  for (const configPath of CONFIG_PATHS) {
    console.log(`Checking configuration at ${configPath}...`);

    // Read the configuration file
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
        console.log(`Successfully repaired ${configPath}`);
      }
    } else {
      console.log(`No issues found with ${configPath}`);
    }
  }

  if (fixedAny) {
    console.log(
      "\nConfiguration files have been fixed. You should restart Traefik to apply changes:"
    );
    console.log("docker restart traefik");
  } else {
    console.log("\nNo configuration files were modified.");
  }
}

// Run the main function
fixTraefikConfig().catch((err) => {
  console.error("Error fixing Traefik configuration:", err);
  process.exit(1);
});
