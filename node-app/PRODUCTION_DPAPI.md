# HAProxy Data Plane API Implementation - Production Guide

This document outlines the production implementation of HAProxy with the Data Plane API using the official HAProxy Tech image.

## Overview

For production deployments, we've switched to using the official `haproxytech/haproxy-debian-dataplaneapi` image, which provides:

1. Pre-installed and configured Data Plane API
2. Production-ready configuration
3. Official support from HAProxy Technologies
4. Regular security updates

## Implementation Details

### Docker Configuration

We use the following configuration in `docker-compose.yml`:

```yaml
services:
  haproxy:
    image: haproxytech/haproxy-debian-dataplaneapi:latest
    ports:
      - "80:80"
      - "443:443"
      - "27017:27017"
      - "5555:5555" # Data Plane API port
    environment:
      - DATAPLANEAPI_USER=${HAPROXY_API_USER:-admin}
      - DATAPLANEAPI_PASSWORD=${HAPROXY_API_PASS:-admin}
      - DATAPLANEAPI_PORT=5555
      - DATAPLANEAPI_SCHEME=http # Use https in actual production
    volumes:
      - ./config/haproxy/haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro
      - haproxy-data:/etc/haproxy/dataplaneapi
```

### Environment Configuration

The official image uses the following environment variables:

```
# .env file
DATAPLANEAPI_USER=admin             # API username
DATAPLANEAPI_PASSWORD=admin         # API password
DATAPLANEAPI_SCHEME=http            # API scheme (http or https)
HAPROXY_API_URL=http://haproxy:5555/v2  # URL for the node app to connect to
```

### Security Considerations

For a production environment, you should:

1. **Use HTTPS for the API**:

   ```
   DATAPLANEAPI_SCHEME=https
   ```

2. **Use strong, unique passwords**:

   ```
   DATAPLANEAPI_PASSWORD=<strong-random-password>
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
  baseURL: process.env.HAPROXY_API_URL || "http://haproxy:5555/v2",
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
curl -u admin:admin http://haproxy:5555/v2/health
```

### Viewing HAProxy Info

```bash
curl -u admin:admin http://haproxy:5555/v2/services/haproxy/info
```

### Viewing Configuration

```bash
curl -u admin:admin http://haproxy:5555/v2/services/haproxy/configuration/backends
```

### Updating HAProxy Version

To update HAProxy, change the image tag in `docker-compose.yml`:

```yaml
image: haproxytech/haproxy-debian-dataplaneapi:2.8.3
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
   curl -u admin:admin http://haproxy:5555/v2/health
   ```

### Configuration Issues

If changes aren't applying correctly:

1. Check transaction logs:

   ```bash
   curl -u admin:admin http://haproxy:5555/v2/services/haproxy/transactions
   ```

2. Verify HAProxy configuration:
   ```bash
   docker exec haproxy haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg
   ```

## References

- [HAProxy Data Plane API Documentation](https://www.haproxy.com/documentation/data-plane-api/)
- [Official Docker Image](https://hub.docker.com/r/haproxytech/haproxy-debian-dataplaneapi)
- [HAProxy Technologies GitHub](https://github.com/haproxytech/dataplaneapi)
