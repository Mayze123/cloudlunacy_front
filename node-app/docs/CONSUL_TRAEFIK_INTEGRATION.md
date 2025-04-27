# Consul and Traefik Integration

This document provides details about the integration between Consul and Traefik in the CloudLunacy Front Server.

## Overview

The CloudLunacy Front Server uses Consul as a key-value store for dynamic Traefik configuration. This approach provides several benefits:

1. **Centralized Configuration**: All routing rules are stored in a central location
2. **Dynamic Updates**: Changes are automatically picked up by Traefik without restarts
3. **Reliability**: Consul's distributed nature provides robust, fault-tolerant storage
4. **Scalability**: The system can scale horizontally with multiple Consul and Traefik instances

## Architecture

### Components

1. **Consul**: A distributed key-value store used for configuration storage
2. **Traefik**: A modern reverse proxy and load balancer with native Consul integration
3. **ConsulService**: A Node.js service for managing Consul KV entries
4. **TraefikService**: A Node.js service for interfacing with Traefik

### Data Flow

1. Agent registration request arrives at the API
2. AgentService processes the request and calls ConsulService
3. ConsulService writes configuration to Consul KV store
4. Traefik automatically watches Consul KV store for changes
5. Traefik updates its runtime configuration without restart
6. Traffic flows to the newly registered agent

## Consul Configuration

### Key Structure

Consul keys are organized in a hierarchical structure under the `traefik` prefix:

```
traefik/
├── http/
│   ├── routers/
│   │   └── [agent-name]/
│   │       ├── rule
│   │       ├── service
│   │       └── ...
│   └── services/
│       └── [agent-name]-http/
│           └── loadBalancer/
│               └── servers/
│                   └── ...
└── tcp/
    ├── routers/
    │   └── [agent-name]/
    │       ├── rule
    │       ├── service
    │       └── ...
    └── services/
        └── [agent-name]-mongo/
            └── loadBalancer/
                └── servers/
                    └── ...
```

### Key-Value Pairs

Each router and service configuration is stored as a JSON object:

**HTTP Router Example:**

```json
{
  "entryPoints": ["websecure"],
  "rule": "Host(`agent-name.cloudlunacy.uk`)",
  "service": "agent-name-http",
  "tls": {
    "certResolver": "letsencrypt"
  }
}
```

**HTTP Service Example:**

```json
{
  "loadBalancer": {
    "servers": [
      {
        "url": "http://192.168.1.100:8080"
      }
    ]
  }
}
```

## Traefik Configuration

Traefik is configured to watch the Consul KV store for changes:

```yaml
providers:
  consul:
    endpoint: "consul:8500"
    prefix: "traefik"
    watch: true
```

Traefik also supports the Consul Catalog for service discovery:

```yaml
providers:
  consulCatalog:
    prefix: "traefik"
    exposedByDefault: false
```

## ConsulService Implementation

The `ConsulService` class provides methods for interacting with the Consul KV store:

1. **initialize()**: Set up the Consul client and create the base key structure
2. **registerAgent()**: Add a new agent's HTTP and TCP routes to Consul
3. **unregisterAgent()**: Remove an agent's routes from Consul
4. **set(), get(), delete()**: Basic KV operations

It handles the proper formatting of configuration data for Traefik to consume.

## AgentService Integration

The `AgentService` uses `ConsulService` for all agent registration and deregistration:

1. During initialization, loads existing agents from Consul
2. When registering a new agent, stores configuration in Consul
3. When unregistering an agent, removes configuration from Consul

## Security Considerations

1. **Consul Security**:

   - Consul runs in a Docker container with limited network access
   - Only the node-app service can directly access Consul
   - Future improvements will include ACLs for more granular access control

2. **Traefik Security**:
   - TLS configuration is managed through Traefik
   - Let's Encrypt integration for automatic certificate management
   - HTTP to HTTPS redirection enforced

## Monitoring and Maintenance

### Consul UI

The Consul UI is available for debugging and monitoring:

- Access via http://localhost:8500/ui/ when running locally

### Traefik Dashboard

The Traefik dashboard provides real-time configuration information:

- Access via https://traefik.localhost/ when running locally
- Protected by basic authentication

## Troubleshooting

### Common Issues

1. **Configuration Not Updating**:

   - Check Consul KV store for proper key structure
   - Verify Traefik is properly watching Consul
   - Check Traefik logs for parsing errors

2. **Agent Registration Fails**:

   - Verify Consul service is running and accessible
   - Check network connectivity between containers
   - Examine error logs in the node-app service

3. **Traffic Not Routing**:
   - Verify the agent is properly registered in Consul
   - Check Traefik dashboard for routing rules
   - Ensure the agent service is reachable

### Debugging Commands

```bash
# Check Consul KV store
docker exec consul consul kv get -recurse traefik/

# View Traefik logs
docker logs traefik

# View node-app logs
docker logs cloudlunacy-front
```

## Future Improvements

1. **Consul Cluster**: Deploy Consul in cluster mode for high availability
2. **ACL Implementation**: Add Access Control Lists for improved security
3. **Metrics Integration**: Collect metrics from Consul and Traefik
4. **Backup Solution**: Automated backup of Consul KV data
5. **Health Checks**: Implement health checks for agents in Consul
