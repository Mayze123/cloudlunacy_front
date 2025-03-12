// Add to node-app/scripts/monitor.js

/**
 * System Monitoring Script
 * Runs periodically to check system health and log statistics
 */

const os = require("os");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// Try to load the logger
let logger;
try {
  logger = require("../utils/logger").getLogger("systemMonitor");
} catch (err) {
  // Create a simple console-based logger as fallback
  logger = {
    info: (msg, ...args) =>
      console.log(`[INFO] [systemMonitor] ${msg}`, ...args),
    warn: (msg, ...args) =>
      console.warn(`[WARN] [systemMonitor] ${msg}`, ...args),
    error: (msg, ...args) =>
      console.error(`[ERROR] [systemMonitor] ${msg}`, ...args),
    debug: (msg, ...args) =>
      console.log(`[DEBUG] [systemMonitor] ${msg}`, ...args),
  };
}

// Configuration
const LOG_DIR = process.env.LOG_DIR || "/app/logs";
const STATS_FILE = path.join(LOG_DIR, "system-stats.json");
const RETENTION_DAYS = 7;

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (err) {
    logger.error(`Failed to create log directory: ${err.message}`);
  }
}

/**
 * Collect system metrics
 */
function collectMetrics() {
  const metrics = {
    timestamp: new Date().toISOString(),
    process: {
      uptime: process.uptime(),
      pid: process.pid,
      memory: process.memoryUsage(),
      nodeVersion: process.version,
    },
    system: {
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      hostname: os.hostname(),
      uptime: os.uptime(),
      loadavg: os.loadavg(),
      totalmem: os.totalmem(),
      freemem: os.freemem(),
      cpus: os.cpus().length,
    },
  };

  // Add Docker stats if available
  try {
    const dockerStats = execSync(
      'docker stats --no-stream --format "{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.MemPerc}}"'
    ).toString();
    const containerStats = {};

    dockerStats.split("\n").forEach((line) => {
      if (line.trim()) {
        const [name, cpu, mem, memPerc] = line.split(",");
        containerStats[name] = { cpu, mem, memPerc };
      }
    });

    metrics.docker = containerStats;
  } catch (err) {
    logger.debug(`Docker stats not available: ${err.message}`);
  }

  return metrics;
}

/**
 * Save metrics to a file
 */
function saveMetrics(metrics) {
  try {
    // Read existing metrics if available
    let allMetrics = [];
    try {
      const content = fs.readFileSync(STATS_FILE, "utf8");
      allMetrics = JSON.parse(content);

      // Ensure it's an array
      if (!Array.isArray(allMetrics)) {
        allMetrics = [];
      }
    } catch (err) {
      // File doesn't exist or is invalid, start with empty array
      allMetrics = [];
    }

    // Add new metrics
    allMetrics.push(metrics);

    // Keep only recent entries
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);

    allMetrics = allMetrics.filter((m) => {
      const timestamp = new Date(m.timestamp);
      return timestamp >= cutoffDate;
    });

    // Write to file
    fs.writeFileSync(STATS_FILE, JSON.stringify(allMetrics, null, 2), "utf8");

    return true;
  } catch (err) {
    logger.error(`Failed to save metrics: ${err.message}`);
    return false;
  }
}

/**
 * Check docker container health
 */
function checkContainers() {
  try {
    const containers = execSync(
      'docker ps -a --format "{{.Names}},{{.Status}}"'
    ).toString();

    const containerStatus = {};
    let unhealthyContainers = [];

    containers.split("\n").forEach((line) => {
      if (line.trim()) {
        const [name, status] = line.split(",");
        containerStatus[name] = status;

        if (status.includes("unhealthy") || status.includes("Restarting")) {
          unhealthyContainers.push({ name, status });
        }
      }
    });

    if (unhealthyContainers.length > 0) {
      logger.warn(`Found ${unhealthyContainers.length} unhealthy containers`, {
        containers: unhealthyContainers,
      });
    } else {
      logger.info("All containers are healthy");
    }

    return { containerStatus, unhealthyContainers };
  } catch (err) {
    logger.error(`Failed to check containers: ${err.message}`);
    return { containerStatus: {}, unhealthyContainers: [] };
  }
}

/**
 * Main function
 */
function main() {
  logger.info("Starting system monitoring");

  try {
    // Collect metrics
    const metrics = collectMetrics();
    logger.debug("Collected system metrics", { metrics });

    // Check containers
    const containers = checkContainers();
    metrics.containers = containers.containerStatus;

    // Save metrics
    const saved = saveMetrics(metrics);
    if (saved) {
      logger.info("Successfully saved system metrics");
    }

    // Log critical stats
    const memUsedPercent = 100 - (os.freemem() / os.totalmem()) * 100;
    logger.info(
      `System stats: CPU Load: ${os
        .loadavg()[0]
        .toFixed(2)}, Memory Used: ${memUsedPercent.toFixed(2)}%, Uptime: ${(
        os.uptime() / 3600
      ).toFixed(2)} hours`
    );

    logger.info("System monitoring completed");
  } catch (err) {
    logger.error(`System monitoring failed: ${err.message}`);
  }
}

// Run now and then set interval if running directly
if (require.main === module) {
  main();

  // Run every 15 minutes
  const INTERVAL = 15 * 60 * 1000; // 15 minutes
  setInterval(main, INTERVAL);
}

module.exports = { collectMetrics, checkContainers, main };
