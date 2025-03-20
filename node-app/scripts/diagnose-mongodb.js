// Create this new file to diagnose MongoDB connectivity issues
const { exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);
const yaml = require("yaml");
const fs = require("fs").promises;
const path = require("path");

async function diagnoseMongoDBRouting(agentId) {
  console.log(`Diagnosing MongoDB routing for ${agentId}...`);

  try {
    // 1. Check if Traefik is running
    const { stdout: traefikStatus } = await execAsync(
      'docker ps -f name=traefik --format "{{.Status}}"'
    );
    console.log(`Traefik status: ${traefikStatus || "Not running"}`);

    // 2. Check if port 27017 is open
    const { stdout: portStatus } = await execAsync(
      'netstat -tuln | grep 27017 || echo "Port not open"'
    );
    console.log(`Port 27017 status: ${portStatus}`);

    // 3. Check dynamic.yml configuration
    const configPath =
      process.env.DYNAMIC_CONFIG_PATH || "/app/config/dynamic.yml";
    const configContent = await fs.readFile(configPath, "utf8");
    const config = yaml.parse(configContent);

    // 4. Check if the router exists
    const routerName = `mongodb-${agentId}`;
    const routerExists = config.tcp?.routers?.[routerName] !== undefined;
    console.log(`Router ${routerName} exists: ${routerExists}`);

    if (routerExists) {
      console.log(
        `Router configuration:`,
        JSON.stringify(config.tcp.routers[routerName], null, 2)
      );

      // 5. Check if the service exists
      const serviceName = `${routerName}-service`;
      const serviceExists = config.tcp?.services?.[serviceName] !== undefined;
      console.log(`Service ${serviceName} exists: ${serviceExists}`);

      if (serviceExists) {
        console.log(
          `Service configuration:`,
          JSON.stringify(config.tcp.services[serviceName], null, 2)
        );
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
