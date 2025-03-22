# CloudLunacy Front Server

A Node.js service for dynamically managing Traefik routing rules for MongoDB Docker instances and other applications.

## Features

- **Dynamic Routing:** Automatically updates Traefik's dynamic configuration to add new subdomain routes
- **Agent Management:** Handles registration and authentication of agents that connect to the system
- **MongoDB Management:** Configures and manages MongoDB instances with TLS/SSL support
- **Certificate Management:** Generates and manages TLS certificates for secure communications
- **Secure API:** Provides authenticated endpoints with role-based access control
- **Health Monitoring:** Includes comprehensive health checks and self-healing capabilities
- **Docker Integration:** Works seamlessly with Docker and Docker Compose environments
- **Hot-Reload:** Leverages Traefik's file provider to apply configuration changes without requiring restarts

## Repository Structure

### Root Directory

- `docker-compose.yml` - Production Docker Compose configuration
- `docker-compose.dev.yml` - Development Docker Compose configuration
- `.env` - Production environment variables
- `.env.dev` - Development environment variables
- `start-dev.sh` - Script to start the development environment
- `dev-down.sh` - Script to shut down the development environment
- `reset-dev.sh` - Script to reset the development environment
- `hosts-setup.sh` - Script to set up local host entries for development
- `install.sh` - Production installation script
- `agent-mongodb-tls.sh` - Script to set up MongoDB TLS for agents

### Node.js Application (`node-app/`)

- `server.js` - Main application entry point
- `start.js` - Application startup script
- `Dockerfile` - Production Docker configuration
- `Dockerfile.dev` - Development Docker configuration
- `package.json` - Node.js dependencies and scripts

#### API Routes (`node-app/api/`)

- `routes.js` - Defines all API endpoints

#### API Controllers (`node-app/api/controllers/`)

- `agentController.js` - Handles agent registration and authentication
- `appController.js` - Manages application routing
- `mongodbController.js` - Manages MongoDB subdomains
- `configController.js` - Manages system configuration
- `healthController.js` - Provides health check endpoints
- `certificateController.js` - Handles certificate operations

#### API Middleware (`node-app/api/middleware/`)

- `auth.js` - Authentication and authorization middleware

#### Core Services (`node-app/services/core/`)

- `index.js` - Initializes and exports all core services
- `configManager.js` - Manages configuration files
- `routingManager.js` - Manages Traefik routing rules
- `mongodbService.js` - Manages MongoDB instances and configuration
- `agentService.js` - Handles agent registration and authentication
- `certificateService.js` - Manages TLS certificates
- `routingService.js` - Manages routing configurations
- `configService.js` - Configuration service APIs

#### Utilities (`node-app/utils/`)

- `logger.js` - Logging utility with Winston
- `pathManager.js` - Manages file and directory paths
- `errorHandler.js` - Global error handling middleware
- `configValidator.js` - Validates configuration structures
- `connectivityTester.js` - Tests network connectivity
- `exec.js` - Executes shell commands

## API Endpoints

### Agent Management

- `POST /api/agent/register` - Register a new agent
- `POST /api/agent/authenticate` - Authenticate an agent
- `GET /api/agent/:agentId/status` - Get agent status
- `DELETE /api/agent/:agentId` - Deregister an agent

### Application Management

- `POST /api/frontdoor/add-app` - Add a new application
- `GET /api/app` - List all applications
- `DELETE /api/app/:agentId/:subdomain` - Remove an application

### MongoDB Management

- `POST /api/frontdoor/add-subdomain` - Add a MongoDB subdomain
- `GET /api/mongodb` - List all MongoDB subdomains
- `DELETE /api/mongodb/:agentId` - Remove a MongoDB subdomain
- `GET /api/mongodb/:agentId/test` - Test MongoDB connectivity

### Configuration

- `GET /api/config` - Get global configuration
- `GET /api/config/:agentId` - Get agent-specific configuration
- `POST /api/config/repair` - Repair system configuration

### Health Checks

- `GET /api/health` - Get overall health status
- `GET /api/health/mongo` - Check MongoDB health
- `GET /api/health/traefik` - Check Traefik health
- `POST /api/health/repair` - Repair system health issues
- `GET /api/health/mongodb-listener` - Check MongoDB listener status

### Certificate Management

- `GET /api/certificates/mongodb-ca` - Get MongoDB CA certificate
- `GET /api/certificates/agent/:agentId` - Get agent certificates

## Core Services

### ConfigManager

Manages all configuration files for the system, including Traefik dynamic configuration and static configuration.

### RoutingManager

Handles Traefik routing rules, adding and removing routes for applications and MongoDB instances.

### MongoDBService

Manages MongoDB instances, including port configuration, TLS setup, and connectivity testing.

### AgentService

Handles agent registration, authentication, and management.

### CertificateService

Generates and manages TLS certificates for secure communications.

## Environment Variables

### Required Variables

- `NODE_ENV` - Environment (production, development)
- `NODE_PORT` - Port for the Node.js application (default: 3005)
- `JWT_SECRET` - Secret for JWT token generation
- `TRAEFIK_FILE_PROVIDER_DIR` - Directory for Traefik dynamic configuration
- `TRAEFIK_STATIC_CONFIG_FILE` - Path to Traefik static configuration file
- `MONGODB_HOSTNAME` - MongoDB hostname
- `MONGODB_PORT` - MongoDB port

### Optional Variables

- `HEALTH_CHECK_INTERVAL` - Interval for health checks in milliseconds (default: 900000)
- `LOG_LEVEL` - Logging level (default: info)
- `DOCKER_SOCKET_PATH` - Path to Docker socket (default: /var/run/docker.sock)

## Installation

### Using Docker Compose

1. Clone the repository
2. Configure environment variables in `.env`
3. Run `docker-compose up -d`

### Development Setup

1. Clone the repository
2. Configure environment variables in `.env.dev`
3. Run `bash start-dev.sh`
4. Run `bash hosts-setup.sh` to configure local hosts

## Maintenance

### Health Checks

The system performs automatic health checks every 15 minutes (configurable) to ensure:

- MongoDB port is correctly exposed
- Traefik configuration is valid
- Agent connections are healthy

### Repair Operations

If issues are detected, the system can self-heal using:

- `POST /api/health/repair` - Repair overall system health
- `POST /api/config/repair` - Repair configuration issues

## License

ISC
