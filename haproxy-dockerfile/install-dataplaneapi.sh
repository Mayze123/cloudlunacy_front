#!/bin/bash
# Script to install and configure HAProxy Data Plane API

set -e

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting Data Plane API installation..."

# Configuration - use a known stable version
DPAPI_VERSION="2.7.0"
DPAPI_URL="https://github.com/haproxytech/dataplaneapi/releases/download/v${DPAPI_VERSION}/dataplaneapi_${DPAPI_VERSION}_Linux_x86_64.tar.gz"
DPAPI_BINARY="/usr/local/bin/dataplaneapi"
DPAPI_CONFIG="/usr/local/etc/haproxy/dataplaneapi.yml"
DPAPI_CONFIG_JSON="/usr/local/etc/haproxy/dataplaneapi.json"
DPAPI_TRANSACTION_DIR="/etc/haproxy/dataplaneapi"
DPAPI_MAPS_DIR="/etc/haproxy/maps"
DPAPI_SPOE_DIR="/etc/haproxy/spoe"
DPAPI_CERTS_DIR="/tmp/certs/certs"
DPAPI_PRIVATE_DIR="/tmp/certs/private"
DPAPI_LOG_DIR="/var/log"

# Create necessary directories with proper permissions
for DIR in "${DPAPI_TRANSACTION_DIR}" "${DPAPI_MAPS_DIR}" "${DPAPI_SPOE_DIR}" "${DPAPI_CERTS_DIR}" "${DPAPI_PRIVATE_DIR}" "${DPAPI_LOG_DIR}"; do
    mkdir -p "${DIR}"
    chmod 755 "${DIR}"
done

# Ensure haproxy user owns appropriate directories
chown -R haproxy:haproxy "${DPAPI_TRANSACTION_DIR}" "${DPAPI_MAPS_DIR}" "${DPAPI_SPOE_DIR}" "${DPAPI_CERTS_DIR}" "${DPAPI_PRIVATE_DIR}"
chmod 755 /var/run || true

# Create empty log file with proper permissions
touch "${DPAPI_LOG_DIR}/dataplaneapi.log"
chmod 644 "${DPAPI_LOG_DIR}/dataplaneapi.log"
chown haproxy:haproxy "${DPAPI_LOG_DIR}/dataplaneapi.log"

# Download Data Plane API if not already installed
if [ ! -f "${DPAPI_BINARY}" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Downloading Data Plane API v${DPAPI_VERSION}..."
    
    # Create temporary directory for download
    TMP_DIR=$(mktemp -d)
    cd "${TMP_DIR}"
    
    # Download the binary
    if ! wget -q "${DPAPI_URL}" -O dataplaneapi.tar.gz; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')][ERROR] Failed to download Data Plane API!"
        rm -rf "${TMP_DIR}"
        exit 1
    fi
    
    # Extract the archive
    if ! tar -xzf dataplaneapi.tar.gz; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')][ERROR] Failed to extract Data Plane API archive!"
        rm -rf "${TMP_DIR}"
        exit 1
    fi
    
    # Move binary to destination
    mv dataplaneapi "${DPAPI_BINARY}"
    chmod +x "${DPAPI_BINARY}"
    
    # Cleanup
    rm -rf "${TMP_DIR}"
    
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Data Plane API downloaded and installed."
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Data Plane API already installed."
fi

# Create a new configuration file with a simpler format
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Creating Data Plane API configuration..."

# Create a simpler YAML configuration format
cat > "${DPAPI_CONFIG}" << EOF
host: 0.0.0.0
port: 5555
haproxy:
  config_file: /usr/local/etc/haproxy/haproxy.cfg
  haproxy_bin: /usr/local/sbin/haproxy
  reload_cmd: kill -SIGUSR2 1
  reload_delay: 5
  config_version: 2
  transaction_dir: ${DPAPI_TRANSACTION_DIR}
resources:
  maps_dir: ${DPAPI_MAPS_DIR}
  ssl_certs_dir: ${DPAPI_CERTS_DIR}
  spoe_dir: ${DPAPI_SPOE_DIR}
users:
  - username: admin
    password: admin
    insecure: true
log:
  level: info
EOF

chmod 644 "${DPAPI_CONFIG}"
chown haproxy:haproxy "${DPAPI_CONFIG}"

# Also create a JSON config as a fallback (some versions prefer this)
cat > "${DPAPI_CONFIG_JSON}" << EOF
{
  "host": "0.0.0.0",
  "port": 5555,
  "haproxy": {
    "config_file": "/usr/local/etc/haproxy/haproxy.cfg",
    "haproxy_bin": "/usr/local/sbin/haproxy",
    "reload_cmd": "kill -SIGUSR2 1",
    "reload_delay": 5,
    "config_version": 2,
    "transaction_dir": "${DPAPI_TRANSACTION_DIR}"
  },
  "resources": {
    "maps_dir": "${DPAPI_MAPS_DIR}",
    "ssl_certs_dir": "${DPAPI_CERTS_DIR}",
    "spoe_dir": "${DPAPI_SPOE_DIR}"
  },
  "users": [
    {
      "username": "admin",
      "password": "admin",
      "insecure": true
    }
  ],
  "log": {
    "level": "info"
  }
}
EOF

chmod 644 "${DPAPI_CONFIG_JSON}"
chown haproxy:haproxy "${DPAPI_CONFIG_JSON}"

# Set proper ownership for related files
chown haproxy:haproxy "${DPAPI_BINARY}"

# Verify Data Plane API can start
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Verifying Data Plane API..."
if ! "${DPAPI_BINARY}" -v | grep -q "Data Plane API"; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')][ERROR] Data Plane API verification failed. Binary might be corrupt or incompatible."
    exit 1
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Data Plane API installation completed successfully."
exit 0