#!/bin/bash
set -euo pipefail
IFS=$'\n\t'

# Usage:
#   chmod +x install.sh
#   sudo ./install.sh

# Environment variables must be set or defaulted
# : "${FRONT_REPO_URL:=https://github.com/Mayze123/cloudlunacy_front}"
: "${DOMAIN:=cloudlunacy.local}" # Changed to use a default value
: "${MONGO_DOMAIN:=mongodb.cloudlunacy.uk}"
: "${APP_DOMAIN:=apps.cloudlunacy.uk}"
# : "${CF_EMAIL:?Need to set CF_EMAIL (Cloudflare email)}"
# : "${CF_API_KEY:?Need to set CF_API_KEY (Cloudflare API key)}"
: "${NODE_PORT:=3005}"
: "${JWT_SECRET:=}"
: "${SHARED_NETWORK:=cloudlunacy-network}"
if [ -z "$JWT_SECRET" ]; then
  JWT_SECRET=$(openssl rand -base64 32)
fi

BASE_DIR="/opt/cloudlunacy_front"
CONFIG_DIR="${BASE_DIR}/config"
CERTS_DIR="${BASE_DIR}/traefik-certs"
TRAEFIK_NETWORK="traefik-network"

log() { echo "[INFO] $1"; }
error_exit() { echo "[ERROR] $1" >&2; exit 1; }

if [ -d "${BASE_DIR}" ]; then
  error_exit "Directory ${BASE_DIR} already exists. Aborting."
fi

log "Cloning front server repository..."
git clone "$FRONT_REPO_URL" "${BASE_DIR}" || error_exit "Failed to clone repository."

log "Creating directories..."
mkdir -p "${CERTS_DIR}" "${CONFIG_DIR}" || error_exit "Failed to create directories."

log "Creating .env file..."
cat > "${BASE_DIR}/.env" <<EOF
# CF_EMAIL=${CF_EMAIL}
# CF_API_KEY=${CF_API_KEY}
# DOMAIN=${DOMAIN}
MONGO_DOMAIN=${MONGO_DOMAIN}
APP_DOMAIN=${APP_DOMAIN}
NODE_PORT=${NODE_PORT}
JWT_SECRET=${JWT_SECRET}
SHARED_NETWORK=${SHARED_NETWORK}
EOF

log "Creating Traefik static configuration..."
cat > "${CONFIG_DIR}/traefik.yml" <<'EOF'
# Global settings
global:
  checkNewVersion: false
  sendAnonymousUsage: false

# Entry points definition - explicitly define all needed ports
entryPoints:
  web:
    address: ":80"
    http:
      redirections:
        entryPoint:
          to: websecure
          scheme: https
  websecure:
    address: ":443"
  dashboard:
    address: ":8081"

# API and dashboard configuration
api:
  dashboard: true
  insecure: true

# Add ping endpoint for health checks
ping:
  entryPoint: "web"

# Log configuration - increase to DEBUG for troubleshooting
log:
  level: "DEBUG"
  filePath: "/var/log/traefik/traefik.log"

# Access logs
accessLog:
  filePath: "/var/log/traefik/access.log"

# Configure providers
providers:
  file:
    filename: "/config/dynamic.yml"
    watch: true
  docker:
    endpoint: "unix:///var/run/docker.sock"
    exposedByDefault: false
    watch: true

# Certificate resolver for HTTPS
certificatesResolvers:
  letsencrypt:
    acme:
      email: "m.taibou.i@gmail.com"
      storage: "/traefik-certs/acme.json"
      httpChallenge:
        entryPoint: "web"
EOF

log "Creating Traefik dynamic configuration..."
cat > "${CONFIG_DIR}/dynamic.yml" <<'EOF'
# Dynamic configuration for Traefik
http:
  routers: {}
  services: {}
  middlewares:
    pingMiddleware:
      ping: {}
    # Global redirection middleware - web to websecure
    web-to-websecure:
      redirectScheme:
        scheme: https
        permanent: true
EOF

# Create empty acme.json file with proper permissions
log "Setting up acme.json with correct permissions..."
touch "${CERTS_DIR}/acme.json"
chmod 600 "${CERTS_DIR}/acme.json"

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
  error_exit "Docker is not installed. Please install Docker before continuing."
fi

# Create docker-compose.yml with network configuration
log "Creating docker-compose.yml..."
cat > "${BASE_DIR}/docker-compose.yml" <<EOF
version: '3.8'

services:
  traefik:
    image: traefik:v2.9
    container_name: traefik
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "8081:8081"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./config:/config
      - ./traefik-certs:/traefik-certs
    command:
      - "--configfile=/config/traefik.yml"
    networks:
      - traefik-network
      - ${SHARED_NETWORK}

  node-app:
    build:
      context: ./node-app
      dockerfile: Dockerfile
    container_name: node-app
    restart: unless-stopped
    env_file:
      - ./.env
    ports:
      - "${NODE_PORT}:3005"
    networks:
      - traefik-network
      - ${SHARED_NETWORK}

networks:
  traefik-network:
    name: traefik-network
  ${SHARED_NETWORK}:
    external: true
EOF

# Create shared network if it doesn't exist
log "Ensuring Docker networks exist..."
if ! docker network ls | grep -q "${TRAEFIK_NETWORK}"; then
  log "Creating ${TRAEFIK_NETWORK} network..."
  docker network create "${TRAEFIK_NETWORK}" || error_exit "Failed to create ${TRAEFIK_NETWORK} network."
else
  log "${TRAEFIK_NETWORK} network already exists."
fi

if ! docker network ls | grep -q "${SHARED_NETWORK}"; then
  log "Creating ${SHARED_NETWORK} network..."
  docker network create "${SHARED_NETWORK}" || error_exit "Failed to create ${SHARED_NETWORK} network."
else
  log "${SHARED_NETWORK} network already exists."
fi

log "Starting Docker containers..."
cd "${BASE_DIR}" || error_exit "Failed to change directory"
docker-compose up -d --build --force-recreate || error_exit "Failed to start Docker containers."

log "Waiting for services to start..."
sleep 10

log "Checking service status..."
docker ps | grep -E 'traefik|node-app'

log "Installation completed successfully!"
log "You can access the Traefik dashboard at: http://localhost:8081/dashboard/"
log "To check logs: docker logs -f traefik"