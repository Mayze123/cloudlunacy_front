#!/bin/bash
set -euo pipefail
IFS=$'\n\t'

# Usage:
#   chmod +x install.sh
#   sudo ./install.sh

# Environment variables must be set or defaulted
: "${FRONT_REPO_URL:=https://github.com/Mayze123/cloudlunacy_front}"
: "${MONGO_DOMAIN:=mongodb.cloudlunacy.uk}"
: "${APP_DOMAIN:=apps.cloudlunacy.uk}"
: "${NODE_PORT:=3005}"
: "${JWT_SECRET:=}"
if [ -z "$JWT_SECRET" ]; then
  JWT_SECRET=$(openssl rand -base64 32)
fi

BASE_DIR="/opt/cloudlunacy_front"
CONFIG_DIR="${BASE_DIR}/config"
CERTS_DIR="${BASE_DIR}/traefik-certs"

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
MONGO_DOMAIN=${MONGO_DOMAIN}
APP_DOMAIN=${APP_DOMAIN}
NODE_PORT=${NODE_PORT}
JWT_SECRET=${JWT_SECRET}
EOF

log "Creating Traefik static configuration..."
cat > "${CONFIG_DIR}/traefik.yml" <<'EOF'
entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"
  mongodb:
    address: ":27017"

# Enable debug logging
log:
  level: "DEBUG"

# Access logs
accessLog: {}

certificatesResolvers:
  letsencrypt:
    acme:
      email: "${CF_EMAIL}"
      storage: /traefik-certs/acme.json
      dnsChallenge:
        provider: cloudflare
        delayBeforeCheck: 0

providers:
  file:
    filename: /config/dynamic.yml
    watch: true  # Explicitly enable watching for file changes
  docker:
    endpoint: "unix:///var/run/docker.sock"
    exposedByDefault: false
    watch: true

api:
  dashboard: true
  insecure: true  # Only for debugging - remove in production
EOF

log "Creating Traefik dynamic configuration..."
cat > "${CONFIG_DIR}/dynamic.yml" <<'EOF'
# Initial dynamic configuration
http:
  routers: {}
  services: {}
tcp:
  routers: {}
  services: {}
EOF

# Create empty acme.json file with proper permissions
log "Setting up acme.json with correct permissions..."
touch "${CERTS_DIR}/acme.json"
chmod 600 "${CERTS_DIR}/acme.json"

# Create traefik-network if it doesn't exist
log "Ensuring traefik-network exists..."
if ! docker network ls | grep -q traefik-network; then
  docker network create traefik-network || error_exit "Failed to create traefik-network."
fi

log "Starting Docker containers..."
cd "${BASE_DIR}" || error_exit "Failed to change directory"
docker-compose up -d --build --force-recreate || error_exit "Failed to start Docker containers."

log "Waiting for services to start..."
sleep 10

log "Checking service status..."
docker ps | grep -E 'traefik|node-app'

log "Installation completed successfully!"
log "You can access the Traefik dashboard at: http://localhost:8080/dashboard/"
log "To check logs: docker logs -f traefik"