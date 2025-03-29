# HAProxy Data Plane API Implementation - Production Guide

This document outlines the production implementation of HAProxy with the Data Plane API using the official HAProxy Tech image.

## Overview

For production deployments, we're using the official `haproxytech/haproxy-ubuntu` image, which provides:

1. Pre-installed HAProxy with Data Plane API support
2. Production-ready configuration
3. Official support from HAProxy Technologies
4. Regular security updates

## Implementation Details

### Docker Configuration

We use the following configuration in `docker-compose.yml`:

```yaml
services:
  haproxy:
    image: haproxytech/haproxy-ubuntu:latest
    ports:
      - "80:80"
      - "443:443"
      - "27017:27017"
      - "5555:5555" # Data Plane API port
    volumes:
      - ./config/haproxy/haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:rw
      - ./config/haproxy/dataplaneapi.yml:/usr/local/etc/haproxy/dataplaneapi.yml:rw
      - haproxy-data:/etc/haproxy/dataplaneapi
    environment:
      - HAPROXY_API_USER=${HAPROXY_API_USER:-admin}
      - HAPROXY_API_PASS=${HAPROXY_API_PASS:-admin}
```

### HAProxy Configuration

The HAProxy configuration file includes a userlist for Data Plane API authentication:

```
# Data Plane API user list
userlist dataplaneapi
    user ${HAPROXY_API_USER:-admin} insecure-password ${HAPROXY_API_PASS:-admin}
```

### Data Plane API Configuration

We use a separate configuration file for the Data Plane API at `config/haproxy/dataplaneapi.yml`:

```yaml
dataplaneapi:
  host: 0.0.0.0
  port: 5555
  scheme: http

  haproxy:
    config_file: /usr/local/etc/haproxy/haproxy.cfg
    haproxy_bin: /usr/local/sbin/haproxy

  userlist: dataplaneapi

  transaction:
    transaction_dir: /etc/haproxy/dataplaneapi

  log_targets:
    - log_to: stdout
      log_level: info

  resources:
    reload_delay: 5
    reload_cmd: "kill -SIGUSR2 1"
```

### Environment Configuration

We configure the environment variables in `.env`:

```
# HAProxy Data Plane API Configuration
HAPROXY_API_URL=http://haproxy:5555/v3
HAPROXY_API_USER=admin
HAPROXY_API_PASS=admin
```

## Security Considerations

For a production environment, you should:

1. **Use HTTPS for the API**:

   ```yaml
   dataplaneapi:
     scheme: https
     tls:
       tls_certificate: /path/to/cert.pem
       tls_key: /path/to/key.pem
   ```

2. **Use strong, unique passwords**:

   ```
   userlist dataplaneapi
     user admin insecure-password <strong-random-password>
   ```

3. **Limit access to the API port**:

   - Only expose 5555 to internal networks
   - Use a VPN or SSH tunnel for remote management

4. **Implement proper backup**:
   - Regularly backup the `/etc/haproxy/dataplaneapi` volume

## Node.js Integration

The node-app connects to the HAProxy Data Plane API using:

```javascript
// HAProxy Service
const client = axios.create({
  baseURL: process.env.HAPROXY_API_URL || "http://haproxy:5555/v3",
  auth: {
    username: process.env.HAPROXY_API_USER || "admin",
    password: process.env.HAPROXY_API_PASS || "admin",
  },
  timeout: 15000,
  headers: {
    "Content-Type": "application/json",
  },
});
```

## Maintenance Tasks

### Checking API Status

```bash
curl -u admin:admin http://haproxy:5555/v3/info
```

### Viewing HAProxy Info

```bash
curl -u admin:admin http://haproxy:5555/v3/services/haproxy/info
```

### Viewing Configuration

```bash
curl -u admin:admin http://haproxy:5555/v3/services/haproxy/configuration/backends
```

### Updating HAProxy Version

To update HAProxy, change the image tag in `docker-compose.yml`:

```yaml
image: haproxytech/haproxy-ubuntu:latest
```

## Troubleshooting

### API Connection Issues

If the node application cannot connect to the HAProxy API:

1. Verify HAProxy container is running:

   ```bash
   docker ps | grep haproxy
   ```

2. Check HAProxy logs:

   ```bash
   docker logs haproxy
   ```

3. Verify API is responding:
   ```bash
   curl -u admin:admin http://haproxy:5555/v3/info
   ```

### Configuration Issues

If changes aren't applying correctly:

1. Check transaction logs:

   ```bash
   curl -u admin:admin http://haproxy:5555/v3/services/haproxy/transactions
   ```

2. Verify HAProxy configuration:
   ```bash
   docker exec haproxy haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg
   ```

## References

- [HAProxy Data Plane API Documentation](https://www.haproxy.com/documentation/haproxy-data-plane-api/)
- [Official Docker Image](https://hub.docker.com/r/haproxytech/haproxy-ubuntu)
- [HAProxy Technologies GitHub](https://github.com/haproxytech/dataplaneapi)
