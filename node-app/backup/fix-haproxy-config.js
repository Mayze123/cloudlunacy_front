// fix-haproxy-config.js
//
// This script manages HAProxy configuration files and updates backend servers
// Run with: node fix-haproxy-config.js

const fs = require("fs").promises;
const path = require("path");
const { exec } = require("child_process");
const util = require("util");
const execAsync = util.promisify(exec);

// Configuration paths
const CONFIG_PATHS = [
  "/usr/local/etc/haproxy/haproxy.cfg", // Container path
  "/opt/cloudlunacy_front/config/haproxy/haproxy.cfg", // Host path
  "config/haproxy/haproxy.cfg", // Relative path
];

// MongoDB agent information
const MONGODB_BACKEND = {
  host: process.env.MONGODB_HOST || "127.0.0.1",
  port: process.env.MONGODB_PORT || 27017,
};

/**
 * Read HAProxy configuration file
 */
async function readHAProxyConfig(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return { success: true, data: content };
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
 * Write updated HAProxy configuration file
 */
async function writeHAProxyConfig(filePath, content) {
  try {
    await fs.writeFile(filePath, content, "utf8");
    console.log(`Successfully wrote updated configuration to ${filePath}`);
    return true;
  } catch (err) {
    console.error(`Failed to write configuration to ${filePath}:`, err.message);
    return false;
  }
}

/**
 * Update MongoDB server backend in HAProxy config
 */
function updateMongoDBBackend(configContent, host, port) {
  // Regular expression to find and replace the MongoDB backend server line
  const serverLineRegex = /server\s+mongodb-agent\s+.*$/m;
  const updatedServerLine = `    server mongodb-agent ${host}:${port} check ssl verify none sni str(%[var(txn.agent_id)].mongodb.cloudlunacy.uk) ca-file /etc/ssl/certs/ca.crt crt /etc/ssl/certs/client.pem`;

  // Replace the server line
  return configContent.replace(serverLineRegex, updatedServerLine);
}

/**
 * Validate HAProxy configuration
 */
async function validateHAProxyConfig(configPath) {
  try {
    // Run HAProxy with -c flag to check configuration syntax
    await execAsync(`haproxy -c -f ${configPath}`);
    console.log("HAProxy configuration validation succeeded");
    return true;
  } catch (err) {
    console.error("HAProxy configuration validation failed:", err.message);
    return false;
  }
}

/**
 * Reload HAProxy configuration
 */
async function reloadHAProxyConfig() {
  try {
    // Get the HAProxy container ID
    const containerName = process.env.HAPROXY_CONTAINER || "haproxy";
    const { stdout: containerId } = await execAsync(
      `docker ps -q -f name=${containerName}`
    );

    if (!containerId.trim()) {
      console.error(`No running container found with name ${containerName}`);
      return false;
    }

    // Send SIGUSR2 signal to reload configuration
    await execAsync(`docker kill --signal=SIGUSR2 ${containerId.trim()}`);
    console.log("HAProxy configuration reloaded successfully");
    return true;
  } catch (err) {
    console.error("Failed to reload HAProxy configuration:", err.message);
    return false;
  }
}

/**
 * Main function to update HAProxy configuration
 */
async function updateHAProxyConfig() {
  console.log("Starting HAProxy configuration update...");

  let updatedAny = false;

  for (const configPath of CONFIG_PATHS) {
    console.log(`Checking configuration at ${configPath}...`);

    // Read the configuration file
    const result = await readHAProxyConfig(configPath);

    if (!result.success) {
      console.log(`Skipping ${configPath} due to read error...`);
      continue;
    }

    // Backup current configuration
    await backupFile(configPath);

    // Update MongoDB backend in the configuration
    const updatedConfig = updateMongoDBBackend(
      result.data,
      MONGODB_BACKEND.host,
      MONGODB_BACKEND.port
    );

    if (updatedConfig !== result.data) {
      // Write updated configuration
      const writeSuccess = await writeHAProxyConfig(configPath, updatedConfig);

      if (writeSuccess) {
        updatedAny = true;

        // Validate configuration
        const isValid = await validateHAProxyConfig(configPath);

        if (isValid) {
          console.log(`Successfully updated ${configPath}`);
        } else {
          // Restore backup if validation fails
          console.log(
            `Configuration validation failed, restoring backup for ${configPath}`
          );
          try {
            const backupFiles = await fs.readdir(path.dirname(configPath));
            const latestBackup = backupFiles
              .filter((file) =>
                file.startsWith(path.basename(configPath) + ".backup.")
              )
              .sort()
              .pop();

            if (latestBackup) {
              const backupPath = path.join(
                path.dirname(configPath),
                latestBackup
              );
              await fs.copyFile(backupPath, configPath);
              console.log(`Restored from backup ${backupPath}`);
            }
          } catch (err) {
            console.error(`Failed to restore backup: ${err.message}`);
          }
        }
      }
    } else {
      console.log(`No changes needed for ${configPath}`);
    }
  }

  if (updatedAny) {
    // Reload HAProxy configuration
    await reloadHAProxyConfig();
  }

  return updatedAny;
}

// Run the update function if this script is executed directly
if (require.main === module) {
  updateHAProxyConfig()
    .then((updated) => {
      if (updated) {
        console.log("HAProxy configuration update completed successfully.");
      } else {
        console.log("No HAProxy configuration updates were necessary.");
      }
    })
    .catch((err) => {
      console.error("Error updating HAProxy configuration:", err);
      process.exit(1);
    });
}

module.exports = {
  updateHAProxyConfig,
  validateHAProxyConfig,
  reloadHAProxyConfig,
};
