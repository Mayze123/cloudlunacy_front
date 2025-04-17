# CloudLunacy Front Server

A robust platform for dynamically managing HAProxy routing rules for MongoDB instances and applications with full TLS/SSL encryption support.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
  - [Automatic Installation](#automatic-installation)
  - [Manual Installation](#manual-installation)
- [Configuration](#configuration)
  - [Environment Variables](#environment-variables)
  - [HAProxy Configuration](#haproxy-configuration)
  - [MongoDB Configuration](#mongodb-configuration)
- [SSL Certificate Management](#ssl-certificate-management)
  - [Automatic SSL with Let's Encrypt](#automatic-ssl-with-lets-encrypt)
  - [Manual SSL Certificate Setup](#manual-ssl-certificate-setup)
- [Usage](#usage)
  - [Agent Management](#agent-management)
  - [MongoDB Subdomain Management](#mongodb-subdomain-management)
  - [Application Routing](#application-routing)
- [Maintenance](#maintenance)
  - [Health Checks](#health-checks)
  - [Backup and Restore](#backup-and-restore)
  - [Updating](#updating)
- [Monitoring](#monitoring)
  - [HAProxy Statistics](#haproxy-statistics)
  - [Logging](#logging)
- [Troubleshooting](#troubleshooting)
  - [Common Issues](#common-issues)
  - [Diagnostic Commands](#diagnostic-commands)
- [API Reference](#api-reference)
- [Security Considerations](#security-considerations)
- [Architecture](#architecture)
- [License](#license)

## Overview

CloudLunacy Front Server is a comprehensive solution for managing dynamic routing to MongoDB instances and applications. It uses HAProxy as a reverse proxy, providing TLS encryption, load balancing, and high availability. The system automatically manages SSL certificates, agent registration, and health monitoring.

## Features

- **Dynamic Routing:** Automatically updates HAProxy's configuration to add new subdomain routes
- **Agent Management:** Handles registration and authentication of agents that connect to the system
- **MongoDB Management:** Configures and manages MongoDB instances with TLS/SSL support
- **Certificate Management:** Generates and manages TLS certificates for secure communications
- **Automatic SSL:** Integration with Let's Encrypt for automatic SSL certificate issuance and renewal
- **Secure API:** Provides authenticated endpoints with role-based access control
- **Health Monitoring:** Includes comprehensive health checks and self-healing capabilities
- **Docker Integration:** Works seamlessly with Docker and Docker Compose environments
- **Hot-Reload:** Leverages HAProxy's Data Plane API to apply configuration changes without requiring restarts

## Prerequisites

Before installing CloudLunacy Front Server, ensure you have:

- A Linux server with sudo privileges (Ubuntu 20.04+ or Debian 11+ recommended)
- Domain name(s) configured with DNS pointing to your server
- Docker (20.10+) and Docker Compose (2.0+) installed
- Ports 80, 443, 8081, and 27017 available and not in use
- If using Cloudflare for DNS:
  - Cloudflare account with your domain configured
  - Cloudflare Global API Key
  - Cloudflare Zone API Token with DNS edit permissions
  - Cloudflare DNS API Token for automatic certificate renewal

### Installing Prerequisites

For Ubuntu/Debian:

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Install Docker Compose
sudo apt install -y docker-compose-plugin
sudo apt install -y openssl curl netcat-openbsd git
```

## Installation

### Automatic Installation

The easiest way to install CloudLunacy Front Server is using the provided installation script:

```bash
# Download the installation script
curl -O https://raw.githubusercontent.com/Mayze123/cloudlunacy_front/main/install.sh
chmod +x install.sh

# Run the installation script (interactive mode)
sudo ./install.sh

# OR Run in non-interactive mode
sudo ./install.sh --no-interactive
```

The installation script will:

1. Check prerequisites
2. Create necessary directories
3. Clone the repository
4. Configure the system
5. Set up Docker networks
6. Start containers
7. Verify services

### Manual Installation

If you prefer a manual installation:

```bash
# 1. Clone the repository
git clone https://github.com/Mayze123/cloudlunacy_front.git
cd cloudlunacy_front

# 2. Configure environment variables
cp .env.example .env
nano .env  # Edit with your settings

# 3. Create networks
docker network create haproxy-network
docker network create cloudlunacy-network

# 4. Start the services
docker-compose up -d
```

## Configuration

### Environment Variables

Edit the `.env` file to configure the system:

```bash
# Required settings
DOMAIN=cloudlunacy.local           # Your primary domain
MONGO_DOMAIN=mongodb.cloudlunacy.uk # MongoDB domain
APP_DOMAIN=apps.cloudlunacy.uk     # Applications domain
NODE_PORT=3005                     # Node.js app port
JWT_SECRET=your_secure_jwt_secret  # JWT authentication secret

# SSL/Let's Encrypt settings (for automatic SSL)
CF_EMAIL=your_cloudflare_email@example.com
CF_API_KEY=your_cloudflare_global_api_key
CF_DNS_API_TOKEN=your_cloudflare_dns_api_token
CF_ZONE_API_TOKEN=your_cloudflare_zone_api_token

# Optional settings
LOG_LEVEL=info                     # Logging level (debug, info, warn, error)
HAPROXY_COMPOSE_PATH=/opt/haproxy/docker-compose.yml

# HAProxy Data Plane API settings
HAPROXY_API_URL=http://haproxy:5555/v2
HAPROXY_API_USER=admin
HAPROXY_API_PASS=admin
```

### HAProxy Configuration

The main HAProxy configuration is at `/opt/cloudlunacy_front/config/haproxy/haproxy.cfg`. The system manages this file automatically, but you can make manual adjustments if needed:

```bash
# Edit HAProxy configuration
nano /opt/cloudlunacy_front/config/haproxy/haproxy.cfg

# Check configuration validity
docker exec haproxy haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg

# Apply changes
docker kill -s HUP haproxy
```

### MongoDB Configuration

For each MongoDB instance you want to expose:

1. Register the agent using the API or web interface
2. Configure MongoDB to use SSL/TLS
3. Configure firewall to only allow connections from your CloudLunacy Front Server

## SSL Certificate Management

### Automatic SSL with Let's Encrypt

CloudLunacy Front Server integrates with Let's Encrypt for automatic SSL certificate issuance and renewal:

1. Configure Cloudflare credentials in your `.env` file:

   ```
   CF_EMAIL=your_cloudflare_email@example.com
   CF_API_KEY=your_cloudflare_global_api_key
   CF_DNS_API_TOKEN=your_cloudflare_dns_api_token
   CF_ZONE_API_TOKEN=your_cloudflare_zone_api_token
   ```

2. Issue initial certificates:

   ```bash
   cd /opt/cloudlunacy_front
   docker exec -it cloudlunacy-front node scripts/renew-letsencrypt.js --force
   ```

3. Verify automatic renewal is enabled:

   ```bash
   docker logs cloudlunacy-front | grep "certificate renewal"
   ```

4. Add a cron job for extra reliability (optional):
   ```bash
   # Add to crontab -e
   0 0 * * * docker exec cloudlunacy-front node /app/scripts/renew-letsencrypt.js >> /var/log/certbot-renew.log 2>&1
   ```

### Manual SSL Certificate Setup

If you prefer to manage certificates manually:

1. Place your certificates in `/opt/cloudlunacy_front/config/certs/`:

   ```
   default.crt - Certificate file
   default.key - Private key file
   default.pem - Combined file (cat default.crt default.key > default.pem)
   ```

2. Make sure the permission are correct:

   ```bash
   chmod 600 /opt/cloudlunacy_front/config/certs/*.key
   chmod 600 /opt/cloudlunacy_front/config/certs/*.pem
   ```

3. Reload HAProxy:
   ```bash
   docker kill -s HUP haproxy
   ```

## Usage

### Agent Management

#### Registering a New Agent

```bash
# Using curl
curl -X POST http://localhost:3005/api/agent/register \
  -H "Content-Type: application/json" \
  -d '{"agentId": "my-agent-id"}'
```

#### Retrieving Agent Status

```bash
# Get agent token first
TOKEN=$(curl -s -X POST http://localhost:3005/api/agent/authenticate \
  -H "Content-Type: application/json" \
  -d '{"agentId": "my-agent-id"}' | jq -r .token)

# Get status
curl http://localhost:3005/api/agent/my-agent-id/status \
  -H "Authorization: Bearer $TOKEN"
```

#### Deregistering an Agent

```bash
curl -X DELETE http://localhost:3005/api/agent/my-agent-id \
  -H "Authorization: Bearer $TOKEN"
```

### MongoDB Subdomain Management

#### Adding a MongoDB Subdomain

```bash
curl -X POST http://localhost:3005/api/mongodb/register \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "my-agent-id",
    "targetIp": "192.168.1.100",
    "targetPort": 27017,
    "useTls": true
  }'
```

This registers the MongoDB instance and makes it accessible at `my-agent-id.mongodb.cloudlunacy.uk:27017`

#### Listing MongoDB Subdomains

```bash
curl http://localhost:3005/api/mongodb \
  -H "Authorization: Bearer $TOKEN"
```

#### Removing a MongoDB Subdomain

```bash
curl -X DELETE http://localhost:3005/api/mongodb/my-agent-id \
  -H "Authorization: Bearer $TOKEN"
```

### Application Routing

#### Adding an Application Route

```bash
curl -X POST http://localhost:3005/api/frontdoor/add-app \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "subdomain": "myapp",
    "targetUrl": "http://192.168.1.100:8080",
    "agentId": "my-agent-id"
  }'
```

This makes the application accessible at `myapp.apps.cloudlunacy.uk`

#### Listing Applications

```bash
curl http://localhost:3005/api/app \
  -H "Authorization: Bearer $TOKEN"
```

#### Removing an Application

```bash
curl -X DELETE http://localhost:3005/api/app/my-agent-id/myapp \
  -H "Authorization: Bearer $TOKEN"
```

## Maintenance

### Health Checks

CloudLunacy Front Server performs regular health checks automatically. You can manually check system health:

```bash
# Overall health
curl http://localhost:3005/api/health

# HAProxy health
curl http://localhost:3005/api/health/haproxy \
  -H "Authorization: Bearer $TOKEN"

# MongoDB port health
curl http://localhost:3005/api/health/mongo \
  -H "Authorization: Bearer $TOKEN"
```

### Repairing the System

If issues are detected, you can trigger a repair operation:

```bash
# Repair system configuration
curl -X POST http://localhost:3005/api/config/repair \
  -H "Authorization: Bearer $TOKEN"

# Repair system health
curl -X POST http://localhost:3005/api/health/repair \
  -H "Authorization: Bearer $TOKEN"
```

### Backup and Restore

To back up your CloudLunacy Front Server configuration:

```bash
# Create a backup
cd /opt/cloudlunacy_front
tar -czf cloudlunacy_backup_$(date +%Y%m%d).tar.gz config .env
```

To restore from a backup:

```bash
# Stop the services
cd /opt/cloudlunacy_front
docker-compose down

# Restore configuration
tar -xzf cloudlunacy_backup_YYYYMMDD.tar.gz -C /opt/cloudlunacy_front

# Start the services
docker-compose up -d
```

### Updating

To update CloudLunacy Front Server:

```bash
# Pull latest changes
cd /opt/cloudlunacy_front
git pull

# Rebuild and restart containers
docker-compose down
docker-compose up -d --build
```

## Monitoring

### HAProxy Statistics

HAProxy provides a statistics dashboard accessible at:

```
http://localhost:8081/stats
```

Default credentials are configured in the HAProxy config file (admin/admin_password by default).

### Logging

View logs for troubleshooting:

```bash
# HAProxy logs
docker logs haproxy

# CloudLunacy Front Server logs
docker logs cloudlunacy-front

# Follow logs in real-time
docker logs -f cloudlunacy-front
```

Log files are also stored in:

- `/var/log/haproxy/` - HAProxy logs
- `/opt/cloudlunacy_front/logs/` - Application logs

## Troubleshooting

### Common Issues

#### HAProxy Won't Start

Check the configuration:

```bash
docker exec haproxy haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg
```

View logs:

```bash
docker logs haproxy
```

#### HAProxy Data Plane API Issues

Check if the API is running:

```bash
curl -u admin:admin http://localhost:5555/health
```

Verify API access:

```bash
curl -u admin:admin http://localhost:5555/v2/services/haproxy/info
```

If you need to restart the Data Plane API:

```bash
docker restart haproxy
```

#### Certificate Issues

Verify certificate files:

```bash
ls -la /opt/cloudlunacy_front/config/certs/
```

Check certificate validity:

```bash
openssl x509 -in /opt/cloudlunacy_front/config/certs/default.crt -text -noout
```

#### MongoDB Connection Problems

Test connectivity:

```bash
nc -zv your-mongodb-server 27017
```

Verify MongoDB is listening for connections:

```bash
docker exec -it your-mongodb-container ss -tulpn | grep 27017
```

### Diagnostic Commands

```bash
# Check container status
docker ps

# Check Docker networks
docker network ls

# Verify ports are open
netstat -tulpn | grep -E '80|443|8081|27017|5555'

# Test HAProxy configuration
docker exec haproxy haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg

# Check Data Plane API status
curl -u admin:admin http://localhost:5555/health

# View available API endpoints
curl -u admin:admin http://localhost:5555/v2
```

## API Reference

See the [API Documentation](docs/api.md) for details on all available endpoints.

Main API endpoints:

- **Agent Management:**

  - `POST /api/agent/register` - Register a new agent
  - `POST /api/agent/authenticate` - Authenticate an agent
  - `GET /api/agent/:agentId/status` - Get agent status
  - `DELETE /api/agent/:agentId` - Deregister an agent

- **MongoDB Management:**

  - `POST /api/mongodb/register` - Register a MongoDB instance
  - `GET /api/mongodb` - List MongoDB subdomains
  - `DELETE /api/mongodb/:agentId` - Remove subdomain

- **App Management:**
  - `POST /api/frontdoor/add-app` - Add application route
  - `GET /api/app` - List applications
  - `DELETE /api/app/:agentId/:subdomain` - Remove application

## Security Considerations

- **JWT Secret:** Use a strong, unique JWT secret in the `.env` file
- **Access Control:** Restrict access to the API endpoints through firewalls
- **TLS/SSL:** Ensure TLS is enabled for all communications
- **API Tokens:** Rotate authentication tokens regularly
- **Regular Updates:** Keep all components updated
- **Firewall Rules:** Implement proper firewall rules between components
- **Logging:** Monitor logs for suspicious activities

## Architecture

CloudLunacy Front Server consists of:

1. **HAProxy Container:** Handles TLS termination and routing
2. **Node.js Application Container:** Manages configuration and API
3. **Docker Networks:** Isolation between components
4. **Certbot Container:** Manages Let's Encrypt certificate renewal (optional)

### Connection Flow:

1. Client connects to `<subdomain>.mongodb.cloudlunacy.uk` or `<subdomain>.apps.cloudlunacy.uk`
2. HAProxy terminates TLS connection and routes based on hostname
3. For MongoDB: HAProxy establishes a new TLS connection to the target MongoDB server
4. For Apps: HAProxy forwards the request to the target application

## License

ISC

---

For support or contributions, please visit the [GitHub repository](https://github.com/Mayze123/cloudlunacy_front).

### HAProxy Data Plane API Configuration

CloudLunacy Front Server now uses the HAProxy Data Plane API for all HAProxy interactions:

```bash
# HAProxy Data Plane API settings
HAPROXY_API_URL=http://haproxy:5555/v2
HAPROXY_API_USER=admin
HAPROXY_API_PASS=admin
```

The Data Plane API provides several advantages:

- Changes are applied atomically through transactions
- Configuration is validated before being applied
- No need to restart HAProxy when making changes
- Secure authentication for all configuration operations

You can access the Data Plane API directly at:

```
http://your-server:5555/v2/
```

Default credentials are configured in the `.env` file (admin/admin by default).
