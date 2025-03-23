/**
 * This script checks the configuration and status of the CloudLunacy Front system.
 * It validates HAProxy configuration, MongoDB connectivity, and other critical components.
 *
 * Run with: node startup-check.js
 */

const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const YAML = require("yaml");

// Constants
const ROOT_DIR = path.join(__dirname, "..");
const ABSOLUTE_ROOT_DIR = "/opt/cloudlunacy_front";
const HAPROXY_CONFIG_DIR = path.join(ROOT_DIR, "config", "haproxy");
const ABSOLUTE_HAPROXY_CONFIG_DIR = path.join(
  ABSOLUTE_ROOT_DIR,
  "config",
  "haproxy"
);
const SYSTEM_HAPROXY_CONFIG_PATH = "/usr/local/etc/haproxy/haproxy.cfg";
const LOCAL_HAPROXY_CONFIG_PATH = path.join(HAPROXY_CONFIG_DIR, "haproxy.cfg");
const ABSOLUTE_HAPROXY_CONFIG_PATH = path.join(
  ABSOLUTE_HAPROXY_CONFIG_DIR,
  "haproxy.cfg"
);
const DOCKER_COMPOSE_PATH = path.join(ROOT_DIR, "docker-compose.yml");
const ABSOLUTE_DOCKER_COMPOSE_PATH = path.join(
  ABSOLUTE_ROOT_DIR,
  "docker-compose.yml"
);
const AGENTS_DIR = path.join(ROOT_DIR, "config", "agents");
const ABSOLUTE_AGENTS_DIR = path.join(ABSOLUTE_ROOT_DIR, "config", "agents");

/**
 * Check if HAProxy is running
 */
function checkHAProxyRunning() {
  return new Promise((_resolve, _reject) => {
    exec("docker ps | grep haproxy", (error, stdout, _stderr) => {
      if (error) {
        console.error("Error checking if HAProxy is running:", error);
        _resolve(false);
      } else {
        _resolve(stdout.includes("haproxy"));
      }
    });
  });
}

/**
 * Check if MongoDB port is exposed
 */
function checkMongoDBPort() {
  return new Promise((_resolve, _reject) => {
    exec("docker port haproxy | grep 27017", (error, stdout, _stderr) => {
      if (error) {
        console.error("Error checking MongoDB port:", error);
        _resolve(false);
      } else {
        const mongoDBPortExposed = stdout.includes("27017");
        console.log(`MongoDB port exposed: ${mongoDBPortExposed}`);
        _resolve(mongoDBPortExposed);
      }
    });
  });
}

/**
 * Check if HAProxy configuration is valid
 */
function validateHAProxyConfig(configPath) {
  return new Promise((_resolve, _reject) => {
    const command = `docker run --rm -v ${path.dirname(
      configPath
    )}:/usr/local/etc/haproxy haproxy:2.8-alpine haproxy -c -f /usr/local/etc/haproxy/${path.basename(
      configPath
    )}`;
    console.log(`Executing command: ${command}`);

    exec(command, (error, stdout, _stderr) => {
      if (error) {
        console.error(
          `Error validating HAProxy config at ${configPath}:`,
          error
        );
        _resolve(false);
      } else {
        console.log(
          `HAProxy config validation result for ${configPath}:`,
          stdout
        );
        _resolve(true);
      }
    });
  });
}

/**
 * Check docker-compose.yml
 */
function checkDockerCompose() {
  // Check if docker-compose.yml exists
  const dockerComposeExists =
    fs.existsSync(DOCKER_COMPOSE_PATH) ||
    fs.existsSync(ABSOLUTE_DOCKER_COMPOSE_PATH);
  console.log(`Docker Compose file exists: ${dockerComposeExists}`);

  if (!dockerComposeExists) {
    console.error("Docker Compose file not found!");
    return false;
  }

  // Check if docker-compose.yml contains HAProxy service
  try {
    const dockerComposeFilePath = fs.existsSync(DOCKER_COMPOSE_PATH)
      ? DOCKER_COMPOSE_PATH
      : ABSOLUTE_DOCKER_COMPOSE_PATH;
    const dockerComposeFile = fs.readFileSync(dockerComposeFilePath, "utf8");
    const dockerComposeYaml = YAML.parse(dockerComposeFile);

    const hasHAProxy =
      dockerComposeYaml.services && dockerComposeYaml.services.haproxy;
    console.log(`Docker Compose file has HAProxy service: ${hasHAProxy}`);

    if (!hasHAProxy) {
      console.error("Docker Compose file does not have HAProxy service!");
      return false;
    }

    // Check if HAProxy service exposes MongoDB port
    const haproxyPorts = dockerComposeYaml.services.haproxy.ports || [];
    const mongoDBPortExposed = haproxyPorts.some((port) =>
      port.includes("27017")
    );
    console.log(`HAProxy service exposes MongoDB port: ${mongoDBPortExposed}`);

    if (!mongoDBPortExposed) {
      console.warn("HAProxy service does not expose MongoDB port!");
      return false;
    }

    return true;
  } catch {
    console.error("Error parsing Docker Compose file!");
    return false;
  }
}

/**
 * Fix docker-compose.yml
 */
function fixDockerCompose() {
  try {
    const dockerComposeFilePath = fs.existsSync(DOCKER_COMPOSE_PATH)
      ? DOCKER_COMPOSE_PATH
      : ABSOLUTE_DOCKER_COMPOSE_PATH;
    const dockerComposeFile = fs.readFileSync(dockerComposeFilePath, "utf8");
    const dockerComposeYaml = YAML.parse(dockerComposeFile);

    let modified = false;

    // Add HAProxy service if it doesn't exist
    if (!dockerComposeYaml.services || !dockerComposeYaml.services.haproxy) {
      dockerComposeYaml.services = dockerComposeYaml.services || {};
      dockerComposeYaml.services.haproxy = {
        image: "haproxy:2.8-alpine",
        container_name: "haproxy",
        ports: ["443:443", "80:80", "27017:27017"],
        volumes: [
          "./config/haproxy:/usr/local/etc/haproxy:ro",
          "./config/certs:/etc/ssl/certs:ro",
        ],
        restart: "unless-stopped",
        networks: ["proxy"],
      };
      modified = true;
    }

    // Add MongoDB port if it's not exposed
    if (
      dockerComposeYaml.services.haproxy &&
      dockerComposeYaml.services.haproxy.ports
    ) {
      const haproxyPorts = dockerComposeYaml.services.haproxy.ports;
      const mongoDBPortExposed = haproxyPorts.some((port) =>
        port.includes("27017")
      );

      if (!mongoDBPortExposed) {
        haproxyPorts.push("27017:27017");
        modified = true;
      }
    }

    // Create 'proxy' network if it doesn't exist
    if (!dockerComposeYaml.networks || !dockerComposeYaml.networks.proxy) {
      dockerComposeYaml.networks = dockerComposeYaml.networks || {};
      dockerComposeYaml.networks.proxy = { external: true };
      modified = true;
    }

    if (modified) {
      fs.writeFileSync(
        dockerComposeFilePath,
        YAML.stringify(dockerComposeYaml)
      );
      console.log("Docker Compose file has been fixed!");
    }

    return true;
  } catch {
    console.error("Error fixing Docker Compose file!");
    return false;
  }
}

/**
 * Check if HAProxy config is valid
 */
function checkHAProxyConfig() {
  // Check if HAProxy config exists
  const haproxyConfigExists =
    fs.existsSync(SYSTEM_HAPROXY_CONFIG_PATH) ||
    fs.existsSync(LOCAL_HAPROXY_CONFIG_PATH) ||
    fs.existsSync(ABSOLUTE_HAPROXY_CONFIG_PATH);

  console.log(`HAProxy config exists: ${haproxyConfigExists}`);

  if (!haproxyConfigExists) {
    console.error("HAProxy config not found!");
    return false;
  }

  // Validate HAProxy config
  return validateHAProxyConfig(
    fs.existsSync(LOCAL_HAPROXY_CONFIG_PATH)
      ? LOCAL_HAPROXY_CONFIG_PATH
      : fs.existsSync(ABSOLUTE_HAPROXY_CONFIG_PATH)
      ? ABSOLUTE_HAPROXY_CONFIG_PATH
      : SYSTEM_HAPROXY_CONFIG_PATH
  );
}

/**
 * Check agents directories
 */
function checkAgentsDirectories() {
  // Check if agents directory exists
  const agentsDirExists =
    fs.existsSync(AGENTS_DIR) || fs.existsSync(ABSOLUTE_AGENTS_DIR);
  console.log(`Agents directory exists: ${agentsDirExists}`);

  if (!agentsDirExists) {
    console.log("Creating agents directory...");
    try {
      fs.mkdirSync(fs.existsSync(ROOT_DIR) ? AGENTS_DIR : ABSOLUTE_AGENTS_DIR, {
        recursive: true,
      });
    } catch (error) {
      console.error("Error creating agents directory:", error);
      return false;
    }
  }

  return true;
}

/**
 * Restart HAProxy container
 */
function restartHAProxy() {
  return new Promise((_resolve, _reject) => {
    exec("docker restart haproxy", (error, _stdout, _stderr) => {
      if (error) {
        console.error("Error restarting HAProxy:", error);
        _resolve(false);
      } else {
        console.log("HAProxy restarted successfully!");
        _resolve(true);
      }
    });
  });
}

/**
 * Create default HAProxy configuration if needed
 */
function createDefaultHAProxyConfig() {
  const configDir = fs.existsSync(HAPROXY_CONFIG_DIR)
    ? HAPROXY_CONFIG_DIR
    : fs.existsSync(ABSOLUTE_HAPROXY_CONFIG_DIR)
    ? ABSOLUTE_HAPROXY_CONFIG_DIR
    : null;

  if (!configDir) {
    console.log("Creating HAProxy config directory...");
    try {
      fs.mkdirSync(
        fs.existsSync(ROOT_DIR)
          ? HAPROXY_CONFIG_DIR
          : ABSOLUTE_HAPROXY_CONFIG_DIR,
        { recursive: true }
      );
    } catch (error) {
      console.error("Error creating HAProxy config directory:", error);
      return false;
    }
  }

  const configPath = fs.existsSync(HAPROXY_CONFIG_DIR)
    ? LOCAL_HAPROXY_CONFIG_PATH
    : ABSOLUTE_HAPROXY_CONFIG_PATH;

  const defaultConfig = `global
    log /dev/log local0
    log /dev/log local1 notice
    chroot /var/lib/haproxy
    stats socket /var/lib/haproxy/stats mode 666 level admin
    stats timeout 30s
    user haproxy
    group haproxy
    daemon
    
    # Default SSL settings
    ssl-default-bind-options no-sslv3 no-tlsv10 no-tlsv11
    ssl-default-bind-ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384
    
defaults
    log global
    mode tcp
    option tcplog
    option dontlognull
    timeout connect 5000
    timeout client 50000
    timeout server 50000
    
frontend stats
    bind *:8404
    mode http
    stats enable
    stats uri /stats
    stats refresh 10s
    stats auth admin:admin_password
    
frontend mongo_frontend
    bind *:27017 ssl crt /etc/ssl/certs/mongodb.pem
    mode tcp
    option tcplog
    
    # Use TCP/SNI to determine the backend
    acl is_mongodb_domain req.ssl_sni -m end .mongodb.cloudlunacy.uk
    
    # Extract the agent ID from the SNI hostname (everything before first dot)
    http-request set-var(txn.agent_id) req.ssl_sni,field(1,'.')
    
    # Use the agent ID to route to the appropriate backend
    use_backend mongodb-backend if is_mongodb_domain
    
    # Default backend (reject connections)
    default_backend empty-backend
    
backend mongodb-backend
    mode tcp
    balance roundrobin
    option tcp-check
    # Use the extracted agent ID in the backend server configuration
    server mongodb ${process.env.MONGODB_HOST || "mongodb"}:${
    process.env.MONGODB_PORT || "27017"
  } check ssl verify none sni str(%[var(txn.agent_id)].mongodb.cloudlunacy.uk)
    
backend empty-backend
    mode tcp
    timeout server 1s
    server empty-server 127.0.0.1:1 check
`;

  try {
    fs.writeFileSync(configPath, defaultConfig);
    console.log(`Default HAProxy config created at ${configPath}`);
    return true;
  } catch (error) {
    console.error("Error creating default HAProxy config:", error);
    return false;
  }
}

/**
 * Main function
 */
async function main() {
  console.log("==== Starting HAProxy checks ====");

  // Check HAProxy config
  const haproxyConfigValid = await checkHAProxyConfig();
  if (!haproxyConfigValid) {
    console.log("Creating default HAProxy config...");
    createDefaultHAProxyConfig();
  }

  // Check Docker Compose file
  const dockerComposeValid = checkDockerCompose();
  if (!dockerComposeValid) {
    console.log("Fixing Docker Compose file...");
    fixDockerCompose();
  }

  // Check agents directories
  const agentsDirsValid = checkAgentsDirectories();
  if (!agentsDirsValid) {
    console.error("Error with agents directories!");
  }

  // Check if HAProxy is running
  const haproxyRunning = await checkHAProxyRunning();
  if (!haproxyRunning) {
    console.log("HAProxy is not running. Starting HAProxy...");
    exec("docker-compose up -d haproxy", async (error, _stdout, _stderr) => {
      if (error) {
        console.error("Error starting HAProxy:", error);
      } else {
        console.log("HAProxy started successfully!");
        await checkMongoDBPort();
      }
    });
  } else {
    console.log("HAProxy is already running.");
    const _mongoDBPortExposed = await checkMongoDBPort();

    // Check if HAProxy config needs to be reloaded
    // This could be triggered by various conditions, like config changes
    // For this example, we'll restart HAProxy if MongoDB port isn't exposed
    if (!_mongoDBPortExposed) {
      console.log("MongoDB port not exposed. Restarting HAProxy...");
      await restartHAProxy();
      await checkMongoDBPort();
    }
  }

  console.log("==== HAProxy checks completed ====");
}

// Run the main function if this script is executed directly
if (require.main === module) {
  main().catch((err) => {
    console.error("Error in main execution:", err);
    process.exit(1);
  });
}

module.exports = {
  checkHAProxyRunning,
  checkMongoDBPort,
  validateHAProxyConfig,
  checkDockerCompose,
  fixDockerCompose,
  checkHAProxyConfig,
  createDefaultHAProxyConfig,
  checkAgentsDirectories,
  restartHAProxy,
  main,
};
