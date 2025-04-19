#!/bin/bash
# Script to install and configure Data Plane API for HAProxy
# This script fixes configuration issues at the source

set -e

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting Data Plane API installation and setup..."

# Define variables
DATAPLANEAPI_VERSION="2.5.3"  # A version known to be compatible with HAProxy 3.x
HAPROXY_CFG="/usr/local/etc/haproxy/haproxy.cfg"
HAPROXY_PID="/var/run/haproxy.pid"
HAPROXY_SOCK="/var/run/haproxy.sock"
DPAPI_CFG="/usr/local/etc/haproxy/dataplaneapi.yml"
DPAPI_LOG="/var/log/dataplaneapi.log"
DPAPI_TRANSACTION_DIR="/etc/haproxy/dataplaneapi"
BACKUP_DIR="/var/lib/haproxy/backups"

# Create all required directories
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Creating required directories..."
mkdir -p ${DPAPI_TRANSACTION_DIR}
mkdir -p ${BACKUP_DIR}
mkdir -p /etc/haproxy/maps
mkdir -p /etc/haproxy/spoe
mkdir -p /tmp/certs/certs
mkdir -p /tmp/certs/private
mkdir -p /etc/haproxy/errors

# Set proper permissions
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Setting correct permissions..."
chown -R haproxy:haproxy ${DPAPI_TRANSACTION_DIR}
chown -R haproxy:haproxy ${BACKUP_DIR}
chown -R haproxy:haproxy /etc/haproxy/maps
chown -R haproxy:haproxy /etc/haproxy/spoe
chown -R haproxy:haproxy /tmp/certs
chmod 755 /tmp/certs/certs
chmod 700 /tmp/certs/private

# Download and install Data Plane API
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Downloading Data Plane API version ${DATAPLANEAPI_VERSION}..."
wget -q -O /tmp/dataplaneapi.tar.gz https://github.com/haproxytech/dataplaneapi/releases/download/v${DATAPLANEAPI_VERSION}/dataplaneapi_${DATAPLANEAPI_VERSION}_Linux_x86_64.tar.gz

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Installing Data Plane API..."
mkdir -p /tmp/dpapi
tar -xzf /tmp/dataplaneapi.tar.gz -C /tmp/dpapi
mv /tmp/dpapi/dataplaneapi /usr/local/bin/
chmod +x /usr/local/bin/dataplaneapi

# Clean up
rm -rf /tmp/dpapi /tmp/dataplaneapi.tar.gz

# Create a properly formatted Data Plane API configuration
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Creating Data Plane API configuration file..."
cat > ${DPAPI_CFG} << EOF
dataplaneapi:
  host: 0.0.0.0
  port: 5555
  schemes:
    - http
  api_base_path: /v3
  
  haproxy:
    config_file: ${HAPROXY_CFG}
    haproxy_bin: /usr/local/sbin/haproxy
    reload_delay: 5
    reload_strategy: native
    reload_retention: 1
    master_runtime_api: ${HAPROXY_SOCK}
    pid_file: ${HAPROXY_PID}
    connection_timeout: 10
  
  resources:
    maps_dir: /etc/haproxy/maps
    ssl_certs_dir: /tmp/certs/certs
    spoe_dir: /etc/haproxy/spoe
  
  transaction:
    transaction_dir: ${DPAPI_TRANSACTION_DIR}
    max_open_transactions: 20
    max_transaction_age: 600
  
  users:
    - username: admin
      password: admin
      insecure: true
  
  log_targets:
    - log_to: file
      file_path: ${DPAPI_LOG}
      log_level: info
    - log_to: stdout
      log_level: info
  
  api_detailed_errors: true
  disable_version_check: true
  debug: true
EOF

# Ensure proper permissions on config file
chown haproxy:haproxy ${DPAPI_CFG}
chmod 640 ${DPAPI_CFG}

# Create log file with proper permissions
touch ${DPAPI_LOG}
chown haproxy:haproxy ${DPAPI_LOG}
chmod 644 ${DPAPI_LOG}

# Test the Data Plane API configuration
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Testing Data Plane API configuration..."
if ! /usr/local/bin/dataplaneapi --configfile ${DPAPI_CFG} --check-config; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: Data Plane API configuration check failed!"
  exit 1
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Data Plane API installation and setup completed successfully!"
exit 0