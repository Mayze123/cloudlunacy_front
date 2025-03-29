# HAProxy Data Plane API Implementation

This document provides detailed information about the implementation of the HAProxy Data Plane API in the CloudLunacy Front Server.

## Overview

The HAProxy Data Plane API allows for dynamic configuration of HAProxy without requiring restarts. This implementation replaces the previous approach of directly manipulating HAProxy configuration files, offering a more robust and maintainable solution.

## Implementation Components

### 1. Docker Configuration

#### Updated docker-compose.yml

```yaml
services:
  haproxy:
    image: haproxytech/haproxy-debian-dataplaneapi:latest
    ports:
      - "80:80"
      - "443:443"
      - "27017:27017"
      - "5555:5555" # Data Plane API port
    volumes:
      - ./config/haproxy/haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro
      - ./config/haproxy/docker-entrypoint-wrapper.sh:/docker-entrypoint-wrapper.sh:ro
      - ./config/certs:/etc/ssl/certs:ro
      - ./config/certs:/etc/ssl/private:ro
      - haproxy-data:/etc/haproxy/dataplaneapi
    environment:
      - HAPROXY_API_USER=${HAPROXY_API_USER:-admin}
      - HAPROXY_API_PASS=${HAPROXY_API_PASS:-admin}
    entrypoint: ["/bin/sh", "/docker-entrypoint-wrapper.sh"]
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:5555/health"]
```

### 2. HAProxy Configuration

#### Updated haproxy.cfg

```haproxy
global
    # ... existing settings ...

    # Enable Data Plane API
    stats socket ipv4@0.0.0.0:9999 level admin
    stats timeout 2m
    # Enable built-in runtime API and Prometheus metrics
    stats socket /var/run/haproxy.sock mode 666 level admin expose-fd listeners
    stats timeout 30s

# ... existing configuration ...

# Data Plane API Admin
userlist dataplaneapi
    user ${HAPROXY_API_USER:-admin} insecure-password ${HAPROXY_API_PASS:-admin}

# Data Plane API access control
frontend dataplane_api
    bind *:5555
    stats enable
    stats uri /stats
    stats refresh 10s
    stats auth ${HAPROXY_API_USER:-admin}:${HAPROXY_API_PASS:-admin}
    acl authenticated http_auth(dataplaneapi)
    http-request auth realm dataplane_api if !authenticated
    http-request use-service prometheus-exporter if { path /metrics }
    use_backend dataplaneapi if { path_beg /v1/services/haproxy/configuration/ } authenticated
    use_backend dataplaneapi if { path_beg /v2/ } authenticated

backend dataplaneapi
    mode http
    stats enable
    stats uri /stats
    stats refresh 10s
    stats auth ${HAPROXY_API_USER:-admin}:${HAPROXY_API_PASS:-admin}
    option httpchk GET /health
    http-check expect status 200
    server local 127.0.0.1:5555
```

### 3. Environment Configuration

Added to the `.env` file:

```bash
# HAProxy Data Plane API settings
HAPROXY_API_URL=http://haproxy:5555/v2
HAPROXY_API_USER=admin
HAPROXY_API_PASS=admin
```

### 4. Docker Entrypoint Wrapper

Updated `docker-entrypoint-wrapper.sh` to support the Data Plane API:

```bash
#!/bin/sh
set -e

# ... existing script ...

# Create dataplaneapi directory if it doesn't exist
mkdir -p /etc/haproxy/dataplaneapi

# Environment variables for Data Plane API
export HAPROXY_API_USER=${HAPROXY_API_USER:-admin}
export HAPROXY_API_PASS=${HAPROXY_API_PASS:-admin}

# ... rest of script ...
```

## Service Implementation

### HAProxyService

The `HAProxyService` class has been updated to use the Data Plane API:

```javascript
class HAProxyService {
  constructor(certificateService) {
    // ... existing code ...

    // Data Plane API configuration
    this.apiBaseUrl = process.env.HAPROXY_API_URL || "http://localhost:5555/v2";
    this.apiUsername = process.env.HAPROXY_API_USER || "admin";
    this.apiPassword = process.env.HAPROXY_API_PASS || "admin";

    // ... existing code ...
  }

  // API client
  _getApiClient() {
    return axios.create({
      baseURL: this.apiBaseUrl,
      auth: {
        username: this.apiUsername,
        password: this.apiPassword,
      },
      timeout: 10000,
    });
  }

  // Transaction management
  async _startTransaction() {
    try {
      const client = this._getApiClient();
      const response = await client.post("/services/haproxy/transactions");
      this.currentTransaction = response.data.data.id;
      return this.currentTransaction;
    } catch (err) {
      logger.error(`Failed to start transaction: ${err.message}`);
      throw err;
    }
  }

  async _commitTransaction() {
    // ... implementation ...
  }

  async _abortTransaction() {
    // ... implementation ...
  }

  // Route management
  async addHttpRoute(agentId, subdomain, targetUrl, options = {}) {
    // ... uses transactions and Data Plane API ...
  }

  // ... other methods ...
}
```

### CertificateService Integration

The `CertificateService` now interacts with the Data Plane API through the `HAProxyService`:

```javascript
class CertificateService {
  constructor() {
    // ... existing code ...

    // Data Plane API configuration
    this.apiBaseUrl = process.env.HAPROXY_API_URL || "http://localhost:5555/v2";
    this.apiUsername = process.env.HAPROXY_API_USER || "admin";
    this.apiPassword = process.env.HAPROXY_API_PASS || "admin";
  }

  // ... methods ...
}
```

## Advantages of the Data Plane API Implementation

1. **Atomic Changes**: All configuration changes are wrapped in transactions, ensuring consistency
2. **Validation**: Configuration is validated by HAProxy before being applied
3. **No Restarts**: Changes are applied without requiring HAProxy to restart
4. **Security**: API access is protected by authentication
5. **Standardization**: Uses HAProxy's official API rather than custom file manipulations
6. **Monitoring**: Includes health endpoints for better monitoring
7. **Reliability**: Reduces chance of configuration errors breaking the proxy

## Troubleshooting

### Common Data Plane API Issues

1. **Connection Refused**:

   - Check if HAProxy container is running
   - Verify the port mapping in docker-compose.yml

2. **Authentication Failures**:

   - Ensure environment variables are set correctly
   - Check userlist configuration in haproxy.cfg

3. **API Errors**:
   - Check HAProxy logs for detailed error messages
   - Verify configuration syntax

### Useful Diagnostic Commands

```bash
# Check API health
curl -u admin:admin http://localhost:5555/health

# Get HAProxy version info
curl -u admin:admin http://localhost:5555/v2/services/haproxy/info

# List current backends
curl -u admin:admin http://localhost:5555/v2/services/haproxy/configuration/backends

# Get runtime info
curl -u admin:admin http://localhost:5555/v2/services/haproxy/runtime/info
```
