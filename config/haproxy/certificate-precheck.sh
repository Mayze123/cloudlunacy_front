#!/bin/bash
# Pre-start certificate validation script
# Runs before HAProxy starts to ensure all certificate directories and files exist
# and have the correct permissions

# Logging function
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

log "Starting certificate pre-check..."

# Check if directories exist (but don't try to create them if they're read-only)
for dir in "/etc/ssl/certs" "/etc/ssl/private"; do
  if [ ! -d "$dir" ]; then
    log "Warning: $dir does not exist, but may not be able to create it if mounted as read-only"
  else
    log "Directory $dir exists"
  fi
done

# Check for MongoDB CA certificate
if [ ! -f "/etc/ssl/certs/mongodb-ca.crt" ]; then
  if [ -f "/etc/ssl/certs/ca.crt" ]; then
    log "MongoDB CA certificate missing, but ca.crt exists"
    # Don't try to create symlink if the filesystem is read-only
    # Instead, report the issue so it can be fixed in the mount configuration
    log "NOTICE: To fix this, ensure mongodb-ca.crt is included in the mounted certificates"
  else
    log "Warning: CA certificate not found at /etc/ssl/certs/ca.crt"
  fi
fi

# Verify there are PEM files in the private directory
PEM_COUNT=$(find /etc/ssl/private -name "*.pem" 2>/dev/null | wc -l)
if [ "$PEM_COUNT" -eq 0 ]; then
  log "Warning: No PEM files found in /etc/ssl/private"
else
  log "Found $PEM_COUNT PEM files in /etc/ssl/private"
fi

# Check if HAProxy config file is valid
if [ -f "/usr/local/etc/haproxy/haproxy.cfg" ]; then
  if haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg; then
    log "HAProxy configuration is valid"
  else
    log "Error: HAProxy configuration is invalid"
  fi
else
  log "Error: HAProxy configuration file not found"
fi

# Special handling for Data Plane API storage directory
if [ ! -d "/etc/haproxy/dataplaneapi" ]; then
  log "Data Plane API storage directory missing, creating"
  mkdir -p /etc/haproxy/dataplaneapi 2>/dev/null || log "Failed to create Data Plane API directory (may be expected if read-only)"
else
  log "Data Plane API directory exists"
fi

# Create compatibility directories if needed and possible
for dir in "/etc/haproxy/maps" "/etc/haproxy/spoe"; do
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir" 2>/dev/null || log "Failed to create $dir (may be expected if read-only)"
  fi
done

log "Certificate pre-check completed"
exit 0