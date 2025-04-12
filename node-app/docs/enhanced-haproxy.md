# Enhanced HAProxy Integration

This document describes the improved HAProxy integration features implemented in Phase 2 of the comprehensive improvement plan.

## Overview

The enhanced HAProxy integration provides improved reliability, monitoring, and management capabilities for the HAProxy service. It includes:

- **Transaction Management**: Atomic operations with proper error handling and rollback capabilities
- **Circuit Breaking**: Prevention of cascading failures with automatic recovery
- **Enhanced Monitoring**: Real-time health status and metrics collection
- **Self-healing**: Automatic recovery from common failure modes
- **API Integration**: REST API endpoints for monitoring and management

## Transaction Management

The transaction manager ensures that configuration changes to HAProxy are performed atomically. It provides:

- Automatic transaction creation and handling
- Validation before committing changes
- Automatic rollback on failure
- Prevention of concurrent modifications using file locks

Example usage:

```javascript
const result = await enhancedHAProxyService.addHttpRoute(
  agentId,
  subdomain,
  targetUrl,
  options
);
```

## Circuit Breaking

The circuit breaker prevents cascading failures by automatically detecting when HAProxy is unavailable and failing fast. Features include:

- Automatic detection of HAProxy failures
- Automatic transition between closed, open, and half-open states
- Configurable failure thresholds and reset timeouts
- Health checks for automatic recovery

The circuit breaker has three states:

- **Closed**: Normal operation - requests go through
- **Open**: Failing fast - requests are rejected immediately
- **Half-Open**: Testing if service is back - allowing limited requests

## Enhanced Monitoring

The monitoring system provides real-time visibility into the HAProxy service health and performance:

- Comprehensive health checks of container, process, and API
- Detailed metrics collection (connections, backends, errors)
- Event-based notification for status changes
- Automatic detection of configuration issues

## Health Status API

The following API endpoints are available for monitoring and managing the HAProxy service:

### Get System Health

```
GET /api/health/system
```

Returns the overall system health status including HAProxy.

**Response Example:**

```json
{
  "status": "healthy",
  "timestamp": "2023-05-01T12:00:00.000Z",
  "services": {
    "haproxy": {
      "status": "HEALTHY",
      "circuitState": "CLOSED",
      "lastCheck": "2023-05-01T11:59:00.000Z",
      "metrics": {
        "routeCount": 10,
        "connections": {
          "current": 5,
          "total": 1000,
          "limit": 2000
        }
      }
    }
  }
}
```

### Get HAProxy Health Details

```
GET /api/health/haproxy
```

Returns detailed health metrics for HAProxy.

**Response Example:**

```json
{
  "success": true,
  "health": {
    "timestamp": "2023-05-01T12:00:00.000Z",
    "status": "HEALTHY",
    "circuitState": "CLOSED",
    "metrics": {
      "connections": {
        "current": 5,
        "total": 1000,
        "rate": 10,
        "limit": 2000
      },
      "requests": {
        "total": 5000,
        "rate": 50
      },
      "errors": {
        "total": 10,
        "rate": 0
      },
      "serverStates": {
        "backend1": {
          "status": "UP",
          "errors": 0,
          "connections": 2
        }
      },
      "uptime": 86400,
      "version": "2.4.18"
    },
    "lastCheck": {
      "timestamp": "2023-05-01T11:59:00.000Z",
      "status": "HEALTHY",
      "details": {
        "containerRunning": true,
        "processRunning": true,
        "apiConnected": true,
        "configValid": true,
        "responseTime": 50
      }
    },
    "routeCount": 10,
    "failureCount": 0,
    "recoveryAttempts": 0,
    "circuitDetails": {
      "failureCount": 0,
      "failureThreshold": 5,
      "lastStateChange": "2023-05-01T00:00:00.000Z",
      "lastFailure": null
    }
  }
}
```

### Get HAProxy Statistics

```
GET /api/health/haproxy/stats
```

Returns detailed statistics for HAProxy including frontends, backends, and servers.

**Authentication Required:** Yes (Admin)  
**Headers:** Authorization: Bearer {token}

### Recover HAProxy Service

```
POST /api/health/haproxy/recover
```

Attempts to recover the HAProxy service by restarting it.

**Authentication Required:** Yes (Admin)  
**Headers:**

- Authorization: Bearer {token}
- X-Admin-Key: {admin_key}

**Response Example:**

```json
{
  "success": true,
  "message": "HAProxy service recovered successfully",
  "action": "restart"
}
```

### Validate HAProxy Configuration

```
GET /api/health/haproxy/validate
```

Validates the HAProxy configuration file.

**Authentication Required:** Yes (Admin)  
**Headers:** Authorization: Bearer {token}

**Response Example:**

```json
{
  "success": true,
  "valid": true,
  "message": "HAProxy configuration is valid"
}
```

## Automatic Recovery

The enhanced HAProxy service includes automatic recovery capabilities:

1. **Health Monitoring**: Continuous monitoring of the HAProxy service
2. **Failure Detection**: Quick detection of service failures
3. **Recovery Attempts**: Automatic attempts to restart the service
4. **Circuit Reset**: Automatic circuit breaker reset when service recovers

## Migration Guide

### Using the Enhanced HAProxy Service

The enhanced HAProxy service is available alongside the legacy service for backward compatibility.

To use the enhanced service in your code:

```javascript
const { enhancedHAProxyService } = require("../../services/core");

// Initialize the service if needed
await enhancedHAProxyService.initialize();

// Add an HTTP route with improved reliability
const result = await enhancedHAProxyService.addHttpRoute(
  agentId,
  subdomain,
  targetUrl,
  options
);
```

### API Endpoints

The new health monitoring API endpoints are available at `/api/health/*`. See the Health Status API section for details.

## Troubleshooting

### Circuit Open Errors

If you receive a "Circuit is open" error, it means the HAProxy service is currently unavailable and the circuit breaker is preventing further requests. The service will automatically attempt recovery.

You can:

1. Check the health status using the API
2. Wait for automatic recovery
3. Use the recovery API to attempt manual recovery

### Configuration Validation Errors

If configuration validation fails, check:

1. The HAProxy configuration syntax
2. Network connectivity to the HAProxy service
3. Server definitions in the configuration

Use the validation API endpoint to check if the configuration is valid.
