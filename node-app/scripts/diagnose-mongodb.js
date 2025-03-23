// Create this new file to diagnose MongoDB connectivity issues
const { exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);
const fs = require("fs").promises;

async function diagnoseMongoDBRouting(agentId) {
  console.log(`Diagnosing MongoDB routing for ${agentId}...`);

  try {
    // 1. Check if HAProxy is running
    const { stdout: haproxyStatus } = await execAsync(
      'docker ps -f name=haproxy --format "{{.Status}}"'
    );
    console.log(`HAProxy status: ${haproxyStatus || "Not running"}`);

    // 2. Check if port 27017 is open
    const { stdout: portStatus } = await execAsync(
      'netstat -tuln | grep 27017 || echo "Port not open"'
    );
    console.log(`Port 27017 status: ${portStatus}`);

    // 3. Check HAProxy configuration
    const configPath =
      process.env.HAPROXY_CONFIG_PATH || "/app/config/haproxy/haproxy.cfg";
    const configContent = await fs.readFile(configPath, "utf8");

    // 4. Check if the agent backend exists
    const backendPattern = new RegExp(`backend\\s+mongodb-${agentId}`, "i");
    const backendExists = backendPattern.test(configContent);
    console.log(`Backend for ${agentId} exists: ${backendExists}`);

    if (backendExists) {
      // Extract and show the backend configuration
      const backendRegex = new RegExp(
        `backend\\s+mongodb-${agentId}[\\s\\S]*?(?=\\n\\s*backend|\\n\\s*frontend|$)`,
        "i"
      );
      const backendMatch = configContent.match(backendRegex);
      if (backendMatch) {
        console.log("Backend configuration:");
        console.log(backendMatch[0]);
      }

      // 5. Check if the frontend reference exists
      const frontendRefPattern = new RegExp(
        `use_backend\\s+mongodb-${agentId}\\s+if`,
        "i"
      );
      const frontendRefExists = frontendRefPattern.test(configContent);
      console.log(
        `Frontend reference for ${agentId} exists: ${frontendRefExists}`
      );

      if (frontendRefExists) {
        // Extract and show the frontend rule
        const frontendRuleRegex = new RegExp(
          `use_backend\\s+mongodb-${agentId}\\s+if[^\\n]*`,
          "i"
        );
        const frontendRuleMatch = configContent.match(frontendRuleRegex);
        if (frontendRuleMatch) {
          console.log("Frontend rule configuration:");
          console.log(frontendRuleMatch[0]);
        }
      }
    }

    // 6. Test DNS resolution
    const domainToTest = `${agentId}.mongodb.cloudlunacy.uk`;
    try {
      const { stdout: dnsResult } = await execAsync(
        `dig ${domainToTest} +short || echo "DNS resolution failed"`
      );
      console.log(`DNS resolution for ${domainToTest}: ${dnsResult}`);
    } catch (err) {
      console.log(`DNS resolution test failed: ${err.message}`);
    }

    console.log("Diagnosis complete");
  } catch (err) {
    console.error(`Diagnosis failed: ${err.message}`);
  }
}

// Get agent ID from command line
const agentId = process.argv[2];
if (!agentId) {
  console.error("Please provide an agent ID as argument");
  process.exit(1);
}

diagnoseMongoDBRouting(agentId);
