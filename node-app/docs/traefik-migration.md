# Traefik v2 Migration Guide

This document explains the migration from HAProxy to Traefik v2 in the CloudLunacy Front project.

## Overview

The CloudLunacy Front project previously used HAProxy for all routing and load balancing. This migration switches to Traefik v2, which offers several advantages:

- Declarative configuration that is easier to maintain
- Automatic service discovery via Docker labels
- Built-in Let's Encrypt support
- Better integration with cloud-native environments
- Dynamic configuration reloading without restart
- Comprehensive middleware system

## Key Changes

1. **Configuration Structure**:

   - HAProxy used a single `haproxy.cfg` file and the Data Plane API
   - Traefik uses a main `traefik.yml` file and dynamic configuration files in the `dynamic/` directory
   - Docker labels are now used for service-specific configuration

2. **Route Management**:

   - HTTP and TCP routing now managed via Traefik's file provider
   - Dynamic changes are persisted to YAML configuration files

3. **API Changes**:

   - HAProxy-specific API endpoints have been replaced with Traefik-specific ones
   - The core proxy functionality remains unchanged for backward compatibility

4. **Service Implementation**:
   - `TraefikService` replaces `HAProxyService` and `EnhancedHAProxyService`
   - Intelligent routing now uses Traefik's native capabilities

## Files Modified

- `/config/traefik/*` - New Traefik configuration files
- `docker-compose.yml` - Updated to use Traefik instead of HAProxy
- `node-app/services/core/traefikService.js` - New core service
- `node-app/services/core/index.js` - Updated service registration
- `node-app/services/core/proxyService.js` - Updated to use TraefikService
- `node-app/api/controllers/traefikController.js` - New controller for Traefik
- `node-app/api/routes/traefikRoutes.js` - New routes for Traefik API
- `node-app/services/core/databases/mongodbService.js` - Updated to use TraefikService

## Usage Guide

### Docker Compose

Traefik is now configured as a service in `docker-compose.yml`:

```yaml
traefik:
  image: traefik:v2.9
  container_name: traefik
  # Configuration omitted for brevity
```

### Service Configuration via Labels

Services can now be configured directly via Docker labels:

```yaml
services:
  my-service:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.my-service.rule=Host(`example.com`)"
      - "traefik.http.routers.my-service.entrypoints=websecure"
      - "traefik.http.routers.my-service.tls=true"
```

### API Endpoints

New API endpoints for Traefik management:

- `GET /api/traefik/health` - Get Traefik health status
- `GET /api/traefik/routes` - Get all routes
- `GET /api/traefik/routes/:agentId` - Get routes for a specific agent
- `POST /api/traefik/routes/http` - Add HTTP route
- `POST /api/traefik/routes/mongodb` - Add MongoDB route
- `DELETE /api/traefik/routes` - Remove a route
- `GET /api/traefik/stats` - Get Traefik stats
- `POST /api/traefik/validate` - Validate Traefik configuration
- `POST /api/traefik/recover` - Recover Traefik service after failure

### Backwards Compatibility

The existing proxy endpoints continue to work:

- `POST /api/proxy/http` - Add HTTP route
- `POST /api/proxy/mongodb` - Add MongoDB route
- `DELETE /api/proxy` - Remove a route
- `GET /api/proxy/agents/:agentId` - Get routes for a specific agent
- `GET /api/proxy` - Get all routes

## Monitoring and Troubleshooting

Traefik's dashboard is available at `http://traefik.localhost:8081/dashboard/` with the authentication defined in the `traefik.yml` file.

Common troubleshooting steps:

1. Check Traefik logs: `docker logs traefik`
2. Validate Traefik configuration: `docker exec traefik traefik healthcheck`
3. Check routes configuration file: `/config/traefik/dynamic/routes.yml`
4. Use the API endpoint: `GET /api/traefik/health?refresh=true`

## Future Improvements

1. Implement Traefik middleware for additional features like rate limiting
2. Leverage Traefik's metrics capabilities for better monitoring
3. Explore service weighting for intelligent load balancing
4. Add support for additional entrypoints as needed
