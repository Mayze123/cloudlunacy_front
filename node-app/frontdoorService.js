require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
const express = require("express");
const jwt = require("jsonwebtoken");
const Docker = require("dockerode");
const yaml = require("yaml");

const app = express();
const PORT = process.env.NODE_PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const dynamicConfigPath =
  process.env.DYNAMIC_CONFIG_PATH ||
  path.join(__dirname, "../config/dynamic.yml");
const docker = new Docker({ socketPath: "/var/run/docker.sock" });

app.use(express.json());

function jwtAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader)
    return res.status(401).json({ error: "Missing Authorization header" });
  const token = authHeader.split(" ")[1];
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(403).json({ error: "Invalid token" });
  }
}

async function loadDynamicConfig() {
  try {
    const content = await fs.readFile(dynamicConfigPath, "utf8");
    return content ? yaml.parse(content) : {};
  } catch (err) {
    return {};
  }
}

async function saveDynamicConfig(config) {
  const yamlStr = yaml.stringify(config);
  await fs.writeFile(dynamicConfigPath, yamlStr, "utf8");
}

async function triggerTraefikReload() {
  try {
    const container = docker.getContainer(
      process.env.TRAEFIK_CONTAINER || "traefik"
    );
    if (!container) throw new Error("Traefik container not found");
    await container.kill({ signal: "SIGHUP" });
  } catch (err) {
    throw new Error(`Failed to trigger Traefik reload: ${err.message}`);
  }
}

function validateInput(subdomain, targetIp) {
  const subdomainRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const ipRegex =
    /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
  return subdomainRegex.test(subdomain) && ipRegex.test(targetIp);
}

/**
 * Automatically generate a JWT for a given agent.
 * @param {Object} payload - Agent-specific data (e.g., agentId, permissions).
 * @returns {string} Signed JWT token.
 */
function generateAgentToken(payload) {
  // You might include details such as agentId or roles.
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "24h" });
}

app.post("/api/frontdoor/add-subdomain", jwtAuth, async (req, res) => {
  try {
    const { subdomain, targetIp } = req.body;
    if (!validateInput(subdomain, targetIp)) {
      return res
        .status(400)
        .json({ error: "Invalid subdomain or target IP format." });
    }

    // Load and update Traefik dynamic configuration
    const config = await loadDynamicConfig();
    config.tcp = config.tcp || { routers: {}, services: {} };
    config.tcp.routers[subdomain] = {
      rule: `HostSNI(\`${subdomain}.${process.env.DOMAIN}\`)`,
      service: `${subdomain}-service`,
    };
    config.tcp.services[`${subdomain}-service`] = {
      loadBalancer: {
        servers: [{ address: `${targetIp}:27017` }],
      },
    };

    await saveDynamicConfig(config);
    await triggerTraefikReload();

    res.json({ success: true, message: "Subdomain added successfully." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/agent/register", async (req, res) => {
  try {
    const { agentId } = req.body;
    // You might add other agent-specific data or permissions
    const token = generateAgentToken({ agentId });
    // Save token info in a database or simply return it
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`Frontdoor API listening on port ${PORT}`);
});
