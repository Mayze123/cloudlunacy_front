#!/bin/bash
# install-certificate-tools.sh
# This script installs the certificate management tools in the HAProxy container

# Log function
log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') - $1"
}

log "Installing certificate management tools..."

# Copy certificate pre-check script to HAProxy container
log "Copying certificate-precheck.sh to HAProxy container..."
if docker ps | grep -q haproxy; then
  docker cp ./config/haproxy/certificate-precheck.sh haproxy:/usr/local/etc/haproxy/certificate-precheck.sh
  docker exec haproxy chmod +x /usr/local/etc/haproxy/certificate-precheck.sh
  log "certificate-precheck.sh installed successfully"
else
  log "ERROR: HAProxy container not running"
fi

# Copy certificate synchronization script to HAProxy container
log "Copying sync-certificates.sh to HAProxy container..."
if docker ps | grep -q haproxy; then
  docker cp ./haproxy-dockerfile/sync-certificates.sh haproxy:/usr/local/bin/sync-certificates.sh
  docker exec haproxy chmod +x /usr/local/bin/sync-certificates.sh
  log "sync-certificates.sh installed successfully"
else
  log "ERROR: HAProxy container not running"
fi

# Create certificate directory structure if needed
log "Setting up certificate directory structure..."
if docker ps | grep -q haproxy; then
  docker exec haproxy mkdir -p /etc/ssl/certs
  docker exec haproxy mkdir -p /etc/ssl/private
  docker exec haproxy chmod 755 /etc/ssl/certs
  docker exec haproxy chmod 700 /etc/ssl/private
  log "Certificate directories set up successfully"
else
  log "ERROR: HAProxy container not running"
fi

# Run the certificate pre-check script
log "Running certificate pre-check..."
if docker ps | grep -q haproxy; then
  docker exec haproxy /usr/local/etc/haproxy/certificate-precheck.sh
  log "Certificate pre-check completed"
else
  log "ERROR: HAProxy container not running"
fi

log "Certificate management tools installation complete"