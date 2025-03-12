// utils/connectivityTester.js

const net = require("net");
const { promisify } = require("util");
const exec = promisify(require("child_process").exec);
const logger = require("./logger").getLogger("connectivityTester");
const fs = require("fs").promises;
const path = require("path");

class ConnectivityTester {
  constructor() {
    // Configuration
    this.mongoDomain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
    this.agentsConfigDir =
      process.env.AGENTS_CONFIG_DIR || "/opt/cloudlunacy_front/config/agents";
    this.mongoPort = 27017;
    this.connectTimeout = 5000; // 5 seconds
    this.testResultsPath =
      process.env.TEST_RESULTS_PATH ||
      "/opt/cloudlunacy_front/logs/connectivity-tests.json";
  }

  /**
   * Test MongoDB port connectivity
   * @param {string} host - Host to connect to
   * @param {number} port - Port to connect to (default: 27017)
   * @returns {Promise<boolean>} - True if connection successful
   */
  async testConnection(host, port = this.mongoPort) {
    return new Promise((resolve) => {
      logger.debug(`Testing connection to ${host}:${port}...`);

      const socket = net.createConnection({
        host,
        port,
      });

      // Set connection timeout
      socket.setTimeout(this.connectTimeout);

      // Connection successful
      socket.on("connect", () => {
        logger.debug(`Connection to ${host}:${port} successful`);
        socket.end();
        resolve(true);
      });

      // Connection timeout
      socket.on("timeout", () => {
        logger.debug(`Connection to ${host}:${port} timed out`);
        socket.destroy();
        resolve(false);
      });

      // Connection error
      socket.on("error", (err) => {
        logger.debug(`Connection to ${host}:${port} failed: ${err.message}`);
        resolve(false);
      });
    });
  }

  /**
   * Test local Traefik listener
   */
  async testTraefikListener() {
    logger.info("Testing Traefik MongoDB listener on localhost");

    const result = await this.testConnection("localhost", this.mongoPort);

    if (result) {
      logger.info("Traefik is correctly listening on port 27017");
    } else {
      logger.warn("Traefik is not listening on port 27017");
    }

    return {
      service: "traefik_listener",
      port: this.mongoPort,
      success: result,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Check DNS resolution for a domain
   */
  async checkDnsResolution(domain) {
    try {
      logger.debug(`Checking DNS resolution for ${domain}...`);

      const { stdout } = await exec(`host ${domain}`);
      logger.debug(`DNS resolution result: ${stdout.trim()}`);

      // Check if it resolved to an IP address
      const hasIpAddress = stdout.includes("has address");

      return {
        domain,
        success: hasIpAddress,
        result: stdout.trim(),
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      logger.debug(`DNS resolution for ${domain} failed: ${err.message}`);

      return {
        domain,
        success: false,
        error: err.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Get list of registered agents
   */
  async getAgentList() {
    try {
      const files = await fs.readdir(this.agentsConfigDir);
      return files
        .filter((file) => file.endsWith(".yml") && file !== "default.yml")
        .map((file) => file.replace(".yml", ""));
    } catch (err) {
      logger.error(`Failed to read agent directory: ${err.message}`);
      return [];
    }
  }

  /**
   * Test all registered agents for MongoDB connectivity
   */
  async testAllAgents() {
    logger.info("Testing MongoDB connectivity for all registered agents");

    // Get list of agents
    const agents = await this.getAgentList();
    logger.info(`Found ${agents.length} registered agents`);

    if (agents.length === 0) {
      return {
        success: true,
        message: "No agents registered",
        agents: [],
      };
    }

    // Test each agent
    const results = [];

    for (const agentId of agents) {
      logger.info(`Testing connectivity for agent ${agentId}`);

      // Generate MongoDB domain for this agent
      const mongoUrl = `${agentId}.${this.mongoDomain}`;

      // Check DNS resolution
      const dnsResult = await this.checkDnsResolution(mongoUrl);

      // Test connectivity
      const connectResult = await this.testConnection(mongoUrl);

      results.push({
        agentId,
        mongoUrl,
        dnsResolution: dnsResult,
        connectivity: {
          success: connectResult,
          timestamp: new Date().toISOString(),
        },
      });
    }

    // Calculate overall success
    const allSuccess = results.every(
      (result) => result.dnsResolution.success && result.connectivity.success
    );

    // Save results
    await this.saveTestResults(results);

    return {
      success: allSuccess,
      message: allSuccess
        ? "All agents are accessible"
        : "Some agents have connectivity issues",
      agents: results,
    };
  }

  /**
   * Run a full connectivity test suite
   */
  async runFullTest() {
    logger.info("Starting full connectivity test suite");

    // Test Traefik listener
    const traefikTest = await this.testTraefikListener();

    // Test agent connectivity
    const agentTests = await this.testAllAgents();

    // Compile all results
    const results = {
      traefik: traefikTest,
      agents: agentTests,
      timestamp: new Date().toISOString(),
    };

    return results;
  }

  /**
   * Save test results to a JSON file
   */
  async saveTestResults(results) {
    try {
      // Create directory if it doesn't exist
      const dir = path.dirname(this.testResultsPath);
      await fs.mkdir(dir, { recursive: true });

      // Read existing results if available
      let history = [];
      try {
        const content = await fs.readFile(this.testResultsPath, "utf8");
        history = JSON.parse(content);
      } catch (err) {
        // File doesn't exist yet, that's fine
      }

      // Add new results to history (keeping last 100 entries)
      history.push({
        results,
        timestamp: new Date().toISOString(),
      });

      // Limit history size
      if (history.length > 100) {
        history = history.slice(-100);
      }

      // Save updated history
      await fs.writeFile(
        this.testResultsPath,
        JSON.stringify(history, null, 2)
      );
      logger.debug("Test results saved successfully");

      return true;
    } catch (err) {
      logger.error(`Failed to save test results: ${err.message}`);
      return false;
    }
  }
}

module.exports = new ConnectivityTester();
