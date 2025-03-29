# CloudLunacy Front Server - Visual Guide

This visual guide explains the CloudLunacy Front Server architecture and operation through a series of diagrams. These diagrams are designed to be easy to understand while providing a comprehensive view of the system.

## Available Diagrams

1. [**CloudLunacy Architecture**](cloudlunacy_architecture.md) - Overview of the system components and flow
2. [**Data Flow**](data_flow.md) - How data moves through the system
3. [**HAProxy Data Plane API Integration**](haproxy_dataplane_integration.md) - Detailed view of the HAProxy integration

## Quick Start Guide

If you're new to the CloudLunacy Front Server, we recommend exploring the diagrams in this order:

1. Start with the **CloudLunacy Architecture** diagram to get a high-level overview
2. Look at the **Data Flow** diagram to understand how requests are processed
3. Dive into the **HAProxy Data Plane API Integration** diagram for details on the HAProxy integration

## Key System Components

### Core Services

- **Server** - The main entry point that initializes and coordinates all services
- **Proxy Service** - Manages routing of requests to appropriate destinations
- **HAProxy Service** - Interfaces with HAProxy via the Data Plane API
- **Agent Service** - Handles agent registration and authentication
- **Config Service** - Manages configuration settings

### External Components

- **HAProxy** - The actual proxy server that routes traffic
- **HAProxy Data Plane API** - The API provided by HAProxy for configuration management

## How It All Works Together

1. **System Initialization**:

   - The server starts and initializes all core services
   - Services establish connections and prepare for operation

2. **Request Processing**:

   - External requests come in through HAProxy
   - HAProxy routes requests based on domain and path
   - Backend services process the requests and return responses

3. **Management Flow**:

   - API requests are received for adding/removing routes
   - The Proxy Service coordinates with the HAProxy Service
   - The HAProxy Service uses the Data Plane API to update HAProxy configuration

4. **Health Monitoring**:
   - Periodic health checks ensure everything is running correctly
   - Automatic repair attempts are made if issues are detected

## Main Benefits of the Architecture

- **Simplified Management** - Single point to manage all routing
- **Dynamic Configuration** - Routes can be added/removed without restart
- **High Reliability** - Uses official HAProxy API for safe updates
- **Separation of Concerns** - Each service has a clear responsibility

The refactored system now uses the HAProxy Data Plane API for all HAProxy interactions, which improves reliability, safety, and maintainability.
