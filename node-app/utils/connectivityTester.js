// utils/connectivityTester.js

const net = require("net");
const { exec } = require("child_process");
const { promisify } = require("util");
const fs = require("fs").promises;
const path = require("path");
const logger = require("./logger").getLogger("connectivityTester");
const { getConfigDir, ensureDirectory } = require("./pathManager");

const execAsync = promisify(exec);

class ConnectivityTester {
  constructor() {
    // Default MongoDB port
    this.mongoPort = process.env.MONGODB_PORT || 27017;

    // Results directory
    this.resultsDir = path.join(getConfigDir(), "test-results");

    // Test timeout in milliseconds (default: 5 seconds)
    this.testTimeout = process.env.TEST_TIMEOUT
      ? parseInt(process.env.TEST_TIMEOUT, 10)
      : 5000;
  }

  /**
   * Test TCP connection to a host and port
   * @param {string} host - The host to connect to
   * @param {number} port - The port to connect to (default: MongoDB port)
   * @returns {Promise<boolean>} - True if connection successful
   */
  async testConnection(host, port = this.mongoPort) {
    return new Promise((resolve) => {
      logger.debug(`Testing connection to ${host}:${port}...`);

      const socket = net.createConnection({
        host,
        port,
        timeout: this.testTimeout,
      });

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
   * Test local HAProxy listener
   */
  async testHAProxyListener() {
    logger.info("Testing HAProxy MongoDB listener on localhost");

    const result = await this.testConnection("localhost", this.mongoPort);

    if (result) {
      logger.info("HAProxy is correctly listening on port 27017");
    } else {
      logger.warn("HAProxy is not listening on port 27017");
    }

    return {
      service: "haproxy_listener",
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

      const { stdout } = await execAsync(`host ${domain}`);
      logger.debug(`DNS resolution result: ${stdout.trim()}`);

      // Check if it resolved to an IP address
      const hasIpAddress = stdout.includes("has address");

      return {
        domain,
        success: hasIpAddress,
        message: stdout.trim(),
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      logger.error(`DNS resolution check failed: ${err.message}`);
      return {
        domain,
        success: false,
        message: err.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Get list of agents to test
   */
  async getAgentList() {
    // For now, we just test a few standard agents
    // This could be expanded to retrieve the actual list of configured agents
    return ["test", "test2", "agent1"];
  }

  /**
   * Test connectivity to all agent endpoints
   */
  async testAllAgents() {
    const agents = await this.getAgentList();
    const results = [];

    for (const agent of agents) {
      logger.info(`Testing connectivity to agent: ${agent}`);

      // Test DNS resolution
      const domainName = `${agent}.mongodb.cloudlunacy.uk`;
      const dnsResult = await this.checkDnsResolution(domainName);
      results.push(dnsResult);

      // If DNS resolved, test connection
      if (dnsResult.success) {
        const connectionResult = await this.testConnection(domainName);

        results.push({
          service: `agent_${agent}`,
          host: domainName,
          port: this.mongoPort,
          success: connectionResult,
          timestamp: new Date().toISOString(),
        });

        if (connectionResult) {
          logger.info(
            `Connection to ${domainName}:${this.mongoPort} successful`
          );
        } else {
          logger.warn(
            `Connection to ${domainName}:${this.mongoPort} failed, even though DNS resolution was successful`
          );
        }
      } else {
        logger.warn(
          `DNS resolution for ${domainName} failed, skipping connection test`
        );
        results.push({
          service: `agent_${agent}`,
          host: domainName,
          port: this.mongoPort,
          success: false,
          error: "DNS resolution failed",
          timestamp: new Date().toISOString(),
        });
      }
    }

    return {
      title: "Agent connectivity tests",
      timestamp: new Date().toISOString(),
      tests: results,
    };
  }

  /**
   * Run a full connectivity test
   */
  async runFullTest() {
    try {
      logger.info("Starting full connectivity test");

      // Create results directory if it doesn't exist
      await ensureDirectory(this.resultsDir);

      // Test local HAProxy instance
      const haproxyTest = await this.testHAProxyListener();

      // Test agent connections
      const agentTests = await this.testAllAgents();

      // Combine results
      const results = {
        timestamp: new Date().toISOString(),
        haproxy: haproxyTest,
        agents: agentTests,
      };

      // Save results
      await this.saveTestResults(results);

      return results;
    } catch (err) {
      logger.error(`Full connectivity test failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Save test results to file
   */
  async saveTestResults(results) {
    try {
      // Format filename with timestamp
      const timestamp = new Date()
        .toISOString()
        .replace(/:/g, "-")
        .replace(/\..+/, "");
      const fileName = `connectivity-test-${timestamp}.json`;
      const filePath = path.join(this.resultsDir, fileName);

      // Write results to file
      await fs.writeFile(filePath, JSON.stringify(results, null, 2));
      logger.info(`Test results saved to ${filePath}`);

      return filePath;
    } catch (err) {
      logger.error(`Failed to save test results: ${err.message}`);
      throw err;
    }
  }
}

module.exports = new ConnectivityTester();
