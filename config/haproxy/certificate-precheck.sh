#!/bin/bash
# Pre-start certificate validation script
# Runs before HAProxy starts to ensure all certificate directories and files exist
# and have the correct permissions

# Logging function
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

log "Starting certificate pre-check..."

# Ensure required directories exist
for dir in "/etc/ssl/certs" "/etc/ssl/private"; do
  if [ ! -d "$dir" ]; then
    log "Error: $dir does not exist, creating it"
    mkdir -p "$dir"
    chmod 755 "$dir"
  fi
done

# Check for MongoDB CA certificate
if [ ! -f "/etc/ssl/certs/mongodb-ca.crt" ]; then
  if [ -f "/etc/ssl/certs/ca.crt" ]; then
    log "MongoDB CA certificate missing, creating symlink from CA certificate"
    ln -sf /etc/ssl/certs/ca.crt /etc/ssl/certs/mongodb-ca.crt
  else
    log "Error: CA certificate not found at /etc/ssl/certs/ca.crt"
    # Don't exit yet, DataPlane API might still work with some limitations
  fi
fi

# Verify expected certificate files in private directory
if [ ! -f "/etc/ssl/private/ca.key" ] && [ -f "/etc/ssl/certs/ca.key" ]; then
  log "CA key not found in private directory, copying from certs directory"
  cp /etc/ssl/certs/ca.key /etc/ssl/private/ca.key
  chmod 600 /etc/ssl/private/ca.key
fi

# Set proper permissions
chmod -R 755 /etc/ssl/certs
find /etc/ssl/certs -type f -exec chmod 644 {} \;

chmod -R 700 /etc/ssl/private
find /etc/ssl/private -type f -exec chmod 600 {} \;

# Verify there are PEM files in the private directory
PEM_COUNT=$(find /etc/ssl/private -name "*.pem" | wc -l)
if [ "$PEM_COUNT" -eq 0 ]; then
  log "Warning: No PEM files found in /etc/ssl/private"
  # Run certificate sync if available and node container is up
  if docker ps | grep -q cloudlunacy-front && [ -f "/usr/local/bin/sync-certificates.sh" ]; then
    log "Attempting to sync certificates from node application"
    /usr/local/bin/sync-certificates.sh
  fi
fi

# Check if HAProxy config file is valid
if [ -f "/usr/local/etc/haproxy/haproxy.cfg" ]; then
  if haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg; then
    log "HAProxy configuration is valid"
  else
    log "Error: HAProxy configuration is invalid"
    # Don't fail here, the main HAProxy process will handle this
  fi
else
  log "Error: HAProxy configuration file not found"
fi

# Special handling for Data Plane API storage directory
if [ ! -d "/etc/haproxy/dataplaneapi" ]; then
  log "Data Plane API storage directory missing, creating"
  mkdir -p /etc/haproxy/dataplaneapi
  chmod 755 /etc/haproxy/dataplaneapi
fi

# Create compatibility symlinks if needed
if [ ! -d "/etc/haproxy/maps" ]; then
  mkdir -p /etc/haproxy/maps
fi

if [ ! -d "/etc/haproxy/spoe" ]; then
  mkdir -p /etc/haproxy/spoe
fi

log "Certificate pre-check completed"
exit 0