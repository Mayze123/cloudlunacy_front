#!/bin/bash
# HAProxy Config Verification Script
# This script checks the validity of the HAProxy configuration file
# and performs basic connectivity tests to ensure proper operation.

set -e

# Function for logging
log_info() {
  echo -e "\e[34m[INFO]\e[0m $1"
}

log_error() {
  echo -e "\e[31m[ERROR]\e[0m $1" >&2
}

log_success() {
  echo -e "\e[32m[SUCCESS]\e[0m $1"
}

# Path to HAProxy configuration
CONFIG_FILE="/usr/local/etc/haproxy/haproxy.cfg"
BACKUP_DIR="/var/lib/haproxy/backups"

# Create backup directory if it doesn't exist
mkdir -p $BACKUP_DIR

# Backup current config before verification
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
cp $CONFIG_FILE "${BACKUP_DIR}/haproxy_${TIMESTAMP}.cfg"
log_info "Configuration backed up to ${BACKUP_DIR}/haproxy_${TIMESTAMP}.cfg"

# Check if HAProxy configuration is valid
log_info "Checking HAProxy configuration..."
if ! haproxy -c -f $CONFIG_FILE; then
  log_error "HAProxy configuration invalid!"
  exit 1
fi
log_success "HAProxy configuration is valid."

# Check DNS resolution for critical services
log_info "Checking DNS resolution for backend services..."
NODE_APP_HOST="cloudlunacy-front"

# Test DNS resolution for Node.js app
if ! nslookup $NODE_APP_HOST > /dev/null 2>&1; then
  log_error "DNS resolution failed for $NODE_APP_HOST"
  log_info "Checking if container exists with docker..."
  if [ -S /var/run/docker.sock ]; then
    if docker ps --format '{{.Names}}' | grep -q "$NODE_APP_HOST"; then
      log_info "Container $NODE_APP_HOST exists but DNS resolution failed."
      log_info "Adding entry to /etc/hosts as workaround..."
      NODE_APP_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' $NODE_APP_HOST 2>/dev/null || echo "")
      if [ -n "$NODE_APP_IP" ]; then
        echo "$NODE_APP_IP $NODE_APP_HOST" >> /etc/hosts
        log_success "Added $NODE_APP_HOST ($NODE_APP_IP) to hosts file."
      else
        log_error "Could not determine IP for $NODE_APP_HOST container."
      fi
    else
      log_error "Container $NODE_APP_HOST does not appear to be running."
    fi
  else
    log_error "Docker socket not available to check container status."
  fi
else
  log_success "DNS resolution for $NODE_APP_HOST successful."
fi

# Check if ports 80, 443, and 8081 are available
log_info "Checking if HAProxy is binding to required ports..."
if ! netstat -tlpn | grep -q ":80.*haproxy" && ! ss -tlpn | grep -q ":80.*haproxy"; then
  log_error "HAProxy is not bound to port 80."
else
  log_success "HAProxy is bound to port 80."
fi

if ! netstat -tlpn | grep -q ":443.*haproxy" && ! ss -tlpn | grep -q ":443.*haproxy"; then
  log_error "HAProxy is not bound to port 443."
else
  log_success "HAProxy is bound to port 443."
fi

if ! netstat -tlpn | grep -q ":8081.*haproxy" && ! ss -tlpn | grep -q ":8081.*haproxy"; then
  log_error "HAProxy is not bound to port 8081."
else
  log_success "HAProxy is bound to port 8081."
fi

log_info "Config verification completed."
exit 0