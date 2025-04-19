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

# Create other required directories
mkdir -p "/etc/haproxy/maps" "/etc/haproxy/spoe" "/tmp/certs/certs" "/tmp/certs/private" "/var/log"
chmod 755 "/etc/haproxy/maps" "/etc/haproxy/spoe" "/tmp/certs/certs" "/tmp/certs/private" "/var/log"
chown -R haproxy:haproxy "/etc/haproxy/maps" "/etc/haproxy/spoe" "/tmp/certs"

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
    
    # Create a minimal config file that matches the expected format
    cat > "${DPAPI_CONFIG}" << EOF
dataplaneapi:
  host: 0.0.0.0
  port: 5555
  schemes:
    - http
  api_base_path: /v3

  haproxy:
    config_file: /usr/local/etc/haproxy/haproxy.cfg
    haproxy_bin: /usr/local/sbin/haproxy
    reload_delay: 5
    reload_strategy: native
    reload_retention: 1
    master_runtime_api: /var/run/haproxy.sock
    pid_file: /var/run/haproxy.pid
    connection_timeout: 10

  users:
    - username: admin
      password: admin
      insecure: true

  transaction:
    transaction_dir: ${DPAPI_TRANSACTION_DIR}
    max_open_transactions: 20
    max_transaction_age: 600

  resources:
    maps_dir: /etc/haproxy/maps
    ssl_certs_dir: /tmp/certs/certs
    spoe_dir: /etc/haproxy/spoe

  log_targets:
    - log_to: file
      file_path: /var/log/dataplaneapi.log
      log_level: info
    - log_to: stdout
      log_level: info

  api_detailed_errors: true
  disable_version_check: true
  debug: true
EOF
    chmod 644 "${DPAPI_CONFIG}"
fi

# Create an empty log file if it doesn't exist
touch /var/log/dataplaneapi.log
chmod 644 /var/log/dataplaneapi.log
chown haproxy:haproxy /var/log/dataplaneapi.log

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