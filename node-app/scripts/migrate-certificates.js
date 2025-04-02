/**
 * Certificate Migration Script
 *
 * This script migrates existing agent certificates to the new multi-agent
 * certificate structure, creating the certificate list and copying certificates
 * to the appropriate directories.
 */
const fs = require("fs").promises;
const path = require("path");
const { execSync } = require("child_process");
const util = require("util");
const execAsync = util.promisify(execSync);

// Configuration
const CERTS_DIR = "/opt/cloudlunacy_front/config/certs";
const AGENTS_DIR = path.join(CERTS_DIR, "agents");
const HAPROXY_CERTS_DIR = "/etc/ssl/certs";
const MONGODB_CERTS_DIR = path.join(HAPROXY_CERTS_DIR, "mongodb");
const CERT_LIST_PATH = path.join(HAPROXY_CERTS_DIR, "mongodb-certs.list");
const MONGO_DOMAIN = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
const HAPROXY_CONTAINER = process.env.HAPROXY_CONTAINER || "haproxy";
const HAPROXY_CONFIG_PATH =
  process.env.HAPROXY_CONFIG_PATH || "/usr/local/etc/haproxy/haproxy.cfg";

async function checkHAProxyConfig() {
  try {
    const configCommand = `docker exec ${HAPROXY_CONTAINER} grep -q "crt-list /etc/ssl/certs/mongodb-certs.list" ${HAPROXY_CONFIG_PATH}`;
    await execAsync(configCommand);
    return true; // Config already uses crt-list
  } catch {
    // If command fails, it means the config doesn't have crt-list
    return false; // Config doesn't use crt-list
  }
}

async function main() {
  try {
    console.log("Starting certificate migration");

    // Check if HAProxy is already configured for certificate list
    const configUsesCrtList = await checkHAProxyConfig();

    if (configUsesCrtList) {
      console.log("HAProxy is already configured to use certificate list");
    } else {
      console.log(
        "WARNING: HAProxy is not yet configured to use certificate list"
      );
      console.log(
        "This script will prepare the certificate structure for future use"
      );
      console.log(
        "Once all agents have been migrated, you should update HAProxy config"
      );
    }

    // Ensure directories exist
    await fs.mkdir(MONGODB_CERTS_DIR, { recursive: true });

    // Get list of agents
    const agents = await fs.readdir(AGENTS_DIR);

    if (agents.length === 0) {
      console.log("No agents found in certificates directory");
      return;
    }

    console.log(`Found ${agents.length} agents to migrate`);

    // Get existing certificate list if it exists
    let certList =
      "# HAProxy Certificate List for MongoDB\n# Format: <path> <SNI>\n\n";
    try {
      const existingList = await fs.readFile(CERT_LIST_PATH, "utf-8");
      certList = existingList;
      console.log("Using existing certificate list file");
    } catch {
      // If file doesn't exist, we'll create a new one
      console.log("Creating new certificate list file");
    }

    // Process each agent
    let migratedCount = 0;
    for (const agentId of agents) {
      try {
        const agentDir = path.join(AGENTS_DIR, agentId);
        const stats = await fs.stat(agentDir);

        // Skip non-directories
        if (!stats.isDirectory()) continue;

        console.log(`Processing agent: ${agentId}`);

        // Check for server.pem file
        const pemPath = path.join(agentDir, "server.pem");
        try {
          await fs.access(pemPath);

          // Copy to the new location
          const agentPemPath = path.join(MONGODB_CERTS_DIR, `${agentId}.pem`);
          await fs.copyFile(pemPath, agentPemPath);
          await fs.chmod(agentPemPath, 0o600);

          // Add to certificate list if not already there
          const certListEntry = `${agentPemPath} ${agentId}.${MONGO_DOMAIN}\n`;
          if (!certList.includes(certListEntry)) {
            certList += certListEntry;
          }

          // Also copy to the standard certificate location for backward compatibility
          await fs.copyFile(
            pemPath,
            path.join(HAPROXY_CERTS_DIR, "mongodb.pem")
          );
          await fs.chmod(path.join(HAPROXY_CERTS_DIR, "mongodb.pem"), 0o600);

          console.log(`  ✅ Migrated certificate for agent ${agentId}`);
          migratedCount++;
        } catch (err) {
          console.error(
            `  ❌ Error processing agent ${agentId}: ${err.message}`
          );
        }
      } catch (agentErr) {
        console.error(`Error processing agent directory: ${agentErr.message}`);
      }
    }

    // Write the updated certificate list file
    await fs.writeFile(CERT_LIST_PATH, certList);
    console.log(
      `Updated certificate list with ${migratedCount} agent certificates`
    );

    console.log("Certificate migration completed successfully!");

    // Only reload HAProxy if it's already configured for certificate list
    if (configUsesCrtList) {
      console.log("Reloading HAProxy to apply changes...");

      // Reload HAProxy
      try {
        await execAsync(
          `docker exec ${HAPROXY_CONTAINER} service haproxy reload`
        );
        console.log("HAProxy reloaded successfully");
      } catch (reloadErr) {
        console.error(`Failed to reload HAProxy: ${reloadErr.message}`);
        console.log("Attempting to restart HAProxy...");

        try {
          await execAsync(`docker restart ${HAPROXY_CONTAINER}`);
          console.log("HAProxy restarted successfully");
        } catch (restartErr) {
          console.error(`Failed to restart HAProxy: ${restartErr.message}`);
          console.error("Please restart HAProxy manually to apply the changes");
        }
      }
    } else {
      console.log(
        "\nHAProxy configuration needs to be updated to use certificate list"
      );
      console.log(
        "To enable multi-certificate support, update the HAProxy config:"
      );
      console.log("1. Edit your HAProxy config file");
      console.log("2. Find the MongoDB frontend section (frontend tcp-in)");
      console.log("3. Replace:");
      console.log(
        "   bind *:27017 ssl crt /etc/ssl/certs/mongodb.pem ssl-min-ver TLSv1.0 ciphers ALL"
      );
      console.log("   With:");
      console.log(
        "   bind *:27017 ssl crt-list /etc/ssl/certs/mongodb-certs.list ssl-min-ver TLSv1.0 ciphers ALL"
      );
      console.log("4. Restart HAProxy");
    }

    console.log("\nTo verify the migration:");
    console.log(`1. Check the certificate list: cat ${CERT_LIST_PATH}`);
    console.log(
      `2. Verify HAProxy configuration: docker exec ${HAPROXY_CONTAINER} haproxy -c -f ${HAPROXY_CONFIG_PATH}`
    );
  } catch (err) {
    console.error(`Migration failed: ${err.message}`);
    process.exit(1);
  }
}

// Run the script
main().catch((err) => {
  console.error(`Unhandled error: ${err.message}`);
  process.exit(1);
});
