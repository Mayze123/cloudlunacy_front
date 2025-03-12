#!/usr/bin/env node
/**
 * MongoDB Health Check Job
 *
 * This script runs as a scheduled job to:
 * 1. Validate MongoDB configuration
 * 2. Test MongoDB connectivity
 * 3. Automatically fix issues when detected
 * 4. Send notifications when issues can't be fixed
 *
 * Usage: node healthcheck-job.js
 */

require("dotenv").config();
const configValidator = require("../utils/configValidator");
const connectivityTester = require("../utils/connectivityTester");
const logger = require("../utils/logger").getLogger("healthCheck");
const fs = require("fs").promises;
const path = require("path");

// Status file to track persistent issues
const STATUS_FILE =
  process.env.HEALTH_STATUS_FILE ||
  "/opt/cloudlunacy_front/logs/mongodb-health-status.json";

/**
 * Send notification (can be extended to email, webhook, etc.)
 */
async function sendNotification(message, data) {
  // Log the notification
  logger.warn(`NOTIFICATION: ${message}`, data);

  // This can be extended to send emails, Slack messages, etc.
  // For example:
  // await emailService.send({
  //   subject: 'MongoDB Health Issue',
  //   body: `${message}\n\nDetails: ${JSON.stringify(data, null, 2)}`
  // });
}

/**
 * Load previous health status
 */
async function loadStatus() {
  try {
    const content = await fs.readFile(STATUS_FILE, "utf8");
    return JSON.parse(content);
  } catch (err) {
    // Return default status if file doesn't exist
    return {
      lastCheck: null,
      consecutiveFailures: 0,
      lastFailure: null,
      lastSuccess: null,
      notificationSent: false,
    };
  }
}

/**
 * Save current health status
 */
async function saveStatus(status) {
  try {
    // Create directory if it doesn't exist
    const dir = path.dirname(STATUS_FILE);
    await fs.mkdir(dir, { recursive: true });

    // Save status
    await fs.writeFile(STATUS_FILE, JSON.stringify(status, null, 2));
    return true;
  } catch (err) {
    logger.error(`Failed to save health status: ${err.message}`);
    return false;
  }
}

/**
 * Run health check and take action on issues
 */
async function runHealthCheck() {
  logger.info("Starting MongoDB health check");

  try {
    // Load previous status
    const status = await loadStatus();

    // Update last check time
    status.lastCheck = new Date().toISOString();

    // Step 1: Validate configuration
    logger.info("Validating MongoDB configuration");
    const configResult = await configValidator.validateAndFix();

    // Step 2: Test connectivity
    logger.info("Testing MongoDB connectivity");
    const connectivityResult = await connectivityTester.runFullTest();

    // Determine overall health status
    const isHealthy =
      configResult.valid &&
      connectivityResult.traefik.success &&
      connectivityResult.agents.success;

    if (isHealthy) {
      logger.info("MongoDB health check passed");

      // Reset failure counter
      status.consecutiveFailures = 0;
      status.lastSuccess = new Date().toISOString();
      status.notificationSent = false;

      // Save updated status
      await saveStatus(status);

      return {
        success: true,
        message: "MongoDB is healthy",
        timestamp: new Date().toISOString(),
      };
    } else {
      logger.warn("MongoDB health check failed");

      // Increment failure counter
      status.consecutiveFailures++;
      status.lastFailure = new Date().toISOString();

      // Collect issues
      const issues = [];

      if (!configResult.valid) {
        issues.push({
          component: "configuration",
          message: "Configuration validation failed",
          details: configResult,
        });
      }

      if (!connectivityResult.traefik.success) {
        issues.push({
          component: "traefik",
          message: "Traefik MongoDB listener is not active",
          details: connectivityResult.traefik,
        });
      }

      if (!connectivityResult.agents.success) {
        const failedAgents = connectivityResult.agents.agents
          .filter((a) => !a.connectivity.success)
          .map((a) => ({
            agentId: a.agentId,
            mongoUrl: a.mongoUrl,
            dnsWorking: a.dnsResolution.success,
          }));

        issues.push({
          component: "agents",
          message: "Some agent MongoDB connections have issues",
          failedAgents,
          details: connectivityResult.agents,
        });
      }

      // Send notification if there are persistent issues (3+ consecutive failures)
      if (status.consecutiveFailures >= 3 && !status.notificationSent) {
        await sendNotification(
          `MongoDB health check has failed ${status.consecutiveFailures} times in a row`,
          { issues }
        );
        status.notificationSent = true;
      }

      // Save updated status
      await saveStatus(status);

      return {
        success: false,
        message: "MongoDB has health issues",
        issues,
        consecutiveFailures: status.consecutiveFailures,
        timestamp: new Date().toISOString(),
      };
    }
  } catch (err) {
    logger.error(`Health check failed with error: ${err.message}`, {
      error: err.message,
      stack: err.stack,
    });

    return {
      success: false,
      error: err.message,
      timestamp: new Date().toISOString(),
    };
  }
}

// Run the health check if this script is executed directly
if (require.main === module) {
  runHealthCheck()
    .then((result) => {
      if (result.success) {
        logger.info("Health check completed successfully");
        process.exit(0);
      } else {
        logger.warn("Health check completed with issues");
        process.exit(1);
      }
    })
    .catch((err) => {
      logger.error(`Unhandled error in health check: ${err.message}`);
      process.exit(1);
    });
}

module.exports = {
  runHealthCheck,
};
