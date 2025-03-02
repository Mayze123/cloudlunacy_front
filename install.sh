#!/bin/bash
set -euo pipefail
IFS=$'\n\t'

# Usage:
#   chmod +x install.sh
#   sudo ./install.sh

# Environment variables must be set or defaulted
: "${FRONT_REPO_URL:=https://github.com/Mayze123/cloudlunacy_front}"
: "${DOMAIN:?Need to set DOMAIN (your domain)}"
: "${MONGO_DOMAIN:=mongodb.cloudlunacy.uk}"
: "${APP_DOMAIN:=apps.cloudlunacy.uk}"
: "${CF_EMAIL:?Need to set CF_EMAIL (Cloudflare email)}"
: "${CF_API_KEY:?Need to set CF_API_KEY (Cloudflare API key)}"
: "${NODE_PORT:=3000}"
: "${JWT_SECRET:=}"
if [ -z "$JWT_SECRET" ]; then
  JWT_SECRET=$(openssl rand -base64 32)
fi

BASE_DIR="/opt/cloudlunacy-front"
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
CF_EMAIL=${CF_EMAIL}
CF_API_KEY=${CF_API_KEY}
DOMAIN=${DOMAIN}
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
  docker:
    endpoint: "unix:///var/run/docker.sock"
    exposedByDefault: false

api:
  dashboard: true
EOF

log "Creating Traefik dynamic configuration..."
touch "${CONFIG_DIR}/dynamic.yml"

log "Starting Docker containers..."
cd "${BASE_DIR}" || error_exit "Failed to change directory"
docker-compose up -d --build --force-recreate || error_exit "Failed to start Docker containers."

log "Installation completed successfully!"