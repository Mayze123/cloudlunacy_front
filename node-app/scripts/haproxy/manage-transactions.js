#!/usr/bin/env node
/**
 * HAProxy Transaction Management Utility
 *
 * A utility script for managing HAProxy Data Plane API transactions in production.
 * This script can list, clean up, or force-commit/abort hanging transactions.
 *
 * Usage:
 *   node manage-transactions.js [command] [options]
 *
 * Commands:
 *   list                List all active transactions
 *   cleanup             Clean up stale transactions (default: older than 10 minutes)
 *   abort <id>          Abort a specific transaction
 *   commit <id>         Force-commit a specific transaction
 *
 * Options:
 *   --age <minutes>     Age threshold in minutes (for cleanup command)
 *   --all               Clean up all transactions regardless of age
 *   --url <url>         API URL (default: http://localhost:5555/v3)
 *   --user <username>   API username (default: admin)
 *   --pass <password>   API password (default: admin)
 *   --force             Force operation even if it might cause issues
 *   --help              Show this help message
 */

const axios = require("axios");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .command("list", "List all active transactions")
  .command("cleanup", "Clean up stale transactions", {
    age: {
      describe: "Age threshold in minutes",
      type: "number",
      default: 10,
    },
    all: {
      describe: "Clean up all transactions regardless of age",
      type: "boolean",
      default: false,
    },
  })
  .command("abort <id>", "Abort a specific transaction", {
    id: {
      describe: "Transaction ID",
      type: "string",
      demandOption: true,
    },
  })
  .command("commit <id>", "Force-commit a specific transaction", {
    id: {
      describe: "Transaction ID",
      type: "string",
      demandOption: true,
    },
    force: {
      describe: "Force commit even if it might cause issues",
      type: "boolean",
      default: false,
    },
  })
  .option("url", {
    describe: "API URL",
    type: "string",
    default: process.env.HAPROXY_API_URL || "http://localhost:5555/v3",
  })
  .option("user", {
    describe: "API username",
    type: "string",
    default: process.env.HAPROXY_API_USER || "admin",
  })
  .option("pass", {
    describe: "API password",
    type: "string",
    default: process.env.HAPROXY_API_PASS || "admin",
  })
  .demandCommand(1, "Please specify a command")
  .help().argv;

// Create API client
const apiClient = axios.create({
  baseURL: argv.url,
  auth: {
    username: argv.user,
    password: argv.pass,
  },
  timeout: 5000,
});

// Main function
async function main() {
  const command = argv._[0];

  try {
    switch (command) {
      case "list":
        await listTransactions();
        break;
      case "cleanup":
        await cleanupTransactions(argv.age, argv.all);
        break;
      case "abort":
        await abortTransaction(argv.id);
        break;
      case "commit":
        await commitTransaction(argv.id, argv.force);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error executing command: ${err.message}`);
    if (err.response) {
      console.error(`Status: ${err.response.status}`);
      console.error("Response:", JSON.stringify(err.response.data, null, 2));
    }
    process.exit(1);
  }
}

// List all active transactions
async function listTransactions() {
  const response = await apiClient.get("/services/haproxy/transactions");
  const transactions = response.data.data || [];

  if (transactions.length === 0) {
    console.log("No active transactions");
    return;
  }

  console.log(`Found ${transactions.length} active transactions:`);
  transactions.forEach((tx) => {
    const createdDate = new Date(tx.created_at);
    const age = Math.round((Date.now() - createdDate.getTime()) / 60000); // in minutes
    console.log(`- ID: ${tx.id}`);
    console.log(`  Created: ${createdDate.toISOString()} (${age} minutes ago)`);
    console.log(`  Status: ${tx.status}`);
    console.log(
      `  Changes: ${tx.version} (${
        tx.versions ? tx.versions.length : 0
      } versions)`
    );
    console.log("");
  });
}

// Clean up stale transactions
async function cleanupTransactions(ageMinutes, cleanupAll) {
  const response = await apiClient.get("/services/haproxy/transactions");
  const transactions = response.data.data || [];

  if (transactions.length === 0) {
    console.log("No active transactions to clean up");
    return;
  }

  console.log(`Found ${transactions.length} active transactions`);

  const ageThreshold = new Date(Date.now() - ageMinutes * 60000).toISOString();
  let cleanedCount = 0;

  for (const tx of transactions) {
    if (cleanupAll || tx.created_at < ageThreshold) {
      console.log(`Aborting transaction ${tx.id} (created: ${tx.created_at})`);
      try {
        await apiClient.delete(`/services/haproxy/transactions/${tx.id}`);
        cleanedCount++;
      } catch (err) {
        console.error(`Failed to abort transaction ${tx.id}: ${err.message}`);
      }
    }
  }

  console.log(`Cleaned up ${cleanedCount} transactions`);
}

// Abort a specific transaction
async function abortTransaction(id) {
  console.log(`Aborting transaction ${id}...`);
  await apiClient.delete(`/services/haproxy/transactions/${id}`);
  console.log(`Transaction ${id} aborted successfully`);
}

// Force-commit a transaction
async function commitTransaction(id, force) {
  console.log(`Committing transaction ${id}...`);

  // If force flag is set, skip validation
  if (force) {
    console.log("Force flag set, skipping validation");
  } else {
    // Validate configuration before committing
    console.log("Validating configuration...");
    try {
      const validationResponse = await apiClient.get(
        `/services/haproxy/configuration/validate?transaction_id=${id}`
      );

      if (!validationResponse.data.data.valid) {
        console.error("Configuration validation failed:");
        console.error(validationResponse.data.data.message);
        console.error("Use --force to commit anyway");
        process.exit(1);
      }

      console.log("Validation successful");
    } catch (err) {
      console.error(`Validation failed: ${err.message}`);
      console.error("Use --force to commit anyway");
      process.exit(1);
    }
  }

  // Commit the transaction
  await apiClient.put(`/services/haproxy/transactions/${id}`);
  console.log(`Transaction ${id} committed successfully`);
}

// Run the main function
main();
