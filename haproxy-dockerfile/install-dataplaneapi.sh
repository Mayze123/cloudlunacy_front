#!/bin/bash
# Script to install and configure HAProxy Data Plane API

set -e

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting Data Plane API installation..."

# Configuration
DPAPI_VERSION="2.9.1"
DPAPI_URL="https://github.com/haproxytech/dataplaneapi/releases/download/v${DPAPI_VERSION}/dataplaneapi_${DPAPI_VERSION}_Linux_x86_64.tar.gz"
DPAPI_BINARY="/usr/local/bin/dataplaneapi"
DPAPI_CONFIG="/usr/local/etc/haproxy/dataplaneapi.yml"
DPAPI_TRANSACTION_DIR="/etc/haproxy/dataplaneapi"

# Create necessary directories with proper permissions
mkdir -p "${DPAPI_TRANSACTION_DIR}"
chmod 755 "${DPAPI_TRANSACTION_DIR}"
chown haproxy:haproxy "${DPAPI_TRANSACTION_DIR}"

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

# Check and configure Data Plane API if config exists
if [ -f "${DPAPI_CONFIG}" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Configuring Data Plane API..."
    
    # Make sure the config file is readable by haproxy user
    chmod 644 "${DPAPI_CONFIG}"
    
    # Ensure transaction dir is correct in the config
    if ! grep -q "${DPAPI_TRANSACTION_DIR}" "${DPAPI_CONFIG}"; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Updating transaction_dir in config file..."
        # This is a simple approach - in a production environment, you might want to use a YAML parser
        sed -i "s|transaction_dir:.*|transaction_dir: ${DPAPI_TRANSACTION_DIR}|g" "${DPAPI_CONFIG}"
    fi
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')][WARNING] Data Plane API config file not found at ${DPAPI_CONFIG}."
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Creating minimal configuration..."
    
    # Create a minimal config file
    cat > "${DPAPI_CONFIG}" << EOF
config_file: /usr/local/etc/haproxy/haproxy.cfg
haproxy:
  config_file: /usr/local/etc/haproxy/haproxy.cfg
  haproxy_bin: /usr/local/sbin/haproxy
  reload_delay: 5
  reload_cmd: service haproxy reload
  restart_cmd: service haproxy restart
  config_test_cmd: /usr/local/sbin/haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg
resources:
  transaction_dir: ${DPAPI_TRANSACTION_DIR}
api:
  host: 0.0.0.0
  port: 5555
  ssl_certs_dir: /tmp/certs/certs
  ssl_key_file: /tmp/certs/private/ca.key
users:
  - name: admin
    password: admin
    insecure: true
EOF
    chmod 644 "${DPAPI_CONFIG}"
fi

# Set proper ownership for related files
chown -R haproxy:haproxy "${DPAPI_CONFIG}" "${DPAPI_BINARY}" "${DPAPI_TRANSACTION_DIR}"

# Verify Data Plane API can start
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Verifying Data Plane API..."
if ! "${DPAPI_BINARY}" -v > /dev/null 2>&1; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')][ERROR] Data Plane API verification failed. Binary might be corrupt or incompatible."
    exit 1
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Data Plane API installation completed successfully."
exit 0