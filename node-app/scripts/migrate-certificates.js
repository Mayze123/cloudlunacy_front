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

async function main() {
  try {
    console.log("Starting certificate migration");

    // Ensure directories exist
    await fs.mkdir(MONGODB_CERTS_DIR, { recursive: true });

    // Get list of agents
    const agents = await fs.readdir(AGENTS_DIR);

    if (agents.length === 0) {
      console.log("No agents found in certificates directory");
      return;
    }

    console.log(`Found ${agents.length} agents to migrate`);

    // Create or clear the certificate list file
    await fs.writeFile(
      CERT_LIST_PATH,
      "# HAProxy Certificate List for MongoDB\n# Format: <path> <SNI>\n\n"
    );
    console.log(`Created certificate list file at ${CERT_LIST_PATH}`);

    // Process each agent
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

          // Add to certificate list
          const certListEntry = `${agentPemPath} ${agentId}.${MONGO_DOMAIN}\n`;
          await fs.appendFile(CERT_LIST_PATH, certListEntry);

          console.log(`  ✅ Migrated certificate for agent ${agentId}`);
        } catch (err) {
          console.error(
            `  ❌ Error processing agent ${agentId}: ${err.message}`
          );
        }
      } catch (agentErr) {
        console.error(`Error processing agent directory: ${agentErr.message}`);
      }
    }

    console.log("Certificate migration completed. Reloading HAProxy...");

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

    console.log("\nMigration completed successfully!");
    console.log("\nTo verify the migration:");
    console.log(`1. Check the certificate list: cat ${CERT_LIST_PATH}`);
    console.log(
      `2. Verify HAProxy configuration: docker exec ${HAPROXY_CONTAINER} haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg`
    );
    console.log(
      `3. Test a MongoDB connection to an agent using the agent's domain: ${agents[0]}.${MONGO_DOMAIN}`
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
