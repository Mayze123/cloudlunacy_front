#!/bin/bash
# Script to synchronize certificates for HAProxy and Data Plane API

set -e

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting certificate synchronization..."

# Directories
CERT_SRC_DIR="/etc/ssl/certs"
CERT_PRIVATE_SRC_DIR="/etc/ssl/private"
CERT_MONGODB_SRC_DIR="${CERT_SRC_DIR}/mongodb"
CERT_AGENTS_SRC_DIR="${CERT_SRC_DIR}/agents"
CERT_DEST_DIR="/tmp/certs/certs"
CERT_PRIVATE_DEST_DIR="/tmp/certs/private"
CERT_AGENTS_DEST_DIR="/tmp/certs/agents"
CONFIG_FILE="/tmp/certs/cert-paths.cfg"

# Create directories if they don't exist
mkdir -p "${CERT_DEST_DIR}" "${CERT_PRIVATE_DEST_DIR}" "${CERT_AGENTS_DEST_DIR}"
chmod 755 "${CERT_DEST_DIR}" 
chmod 700 "${CERT_PRIVATE_DEST_DIR}"
chmod 755 "${CERT_AGENTS_DEST_DIR}"

# Find and copy CA certificates
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Finding and copying CA certificates..."

# Copy CA certificate and key if they exist
if [ -f "${CERT_SRC_DIR}/ca.crt" ]; then
    cp "${CERT_SRC_DIR}/ca.crt" "${CERT_DEST_DIR}/ca.crt"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Copied ${CERT_SRC_DIR}/ca.crt to ${CERT_DEST_DIR}/ca.crt"
    
    # Check for MongoDB CA certificate, use standard CA if not found
    if [ -f "${CERT_SRC_DIR}/mongodb-ca.crt" ]; then
        cp "${CERT_SRC_DIR}/mongodb-ca.crt" "${CERT_DEST_DIR}/mongodb-ca.crt"
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Copied ${CERT_SRC_DIR}/mongodb-ca.crt to ${CERT_DEST_DIR}/mongodb-ca.crt"
    else
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] No specific MongoDB CA certificate found, using CA certificate"
        cp "${CERT_SRC_DIR}/ca.crt" "${CERT_DEST_DIR}/mongodb-ca.crt"
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Copied ${CERT_SRC_DIR}/ca.crt to ${CERT_DEST_DIR}/mongodb-ca.crt"
    fi
    
    # Copy CA key if it exists
    if [ -f "${CERT_SRC_DIR}/ca.key" ]; then
        cp "${CERT_SRC_DIR}/ca.key" "${CERT_PRIVATE_DEST_DIR}/ca.key"
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Copied ${CERT_SRC_DIR}/ca.key to ${CERT_PRIVATE_DEST_DIR}/ca.key"
    fi
fi

# Copy the MongoDB certificate to writable location with proper permissions
if [ -f "${CERT_SRC_DIR}/mongodb.pem" ]; then
    cp "${CERT_SRC_DIR}/mongodb.pem" "/tmp/certs/mongodb.pem"
    chmod 644 "/tmp/certs/mongodb.pem"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Copied ${CERT_SRC_DIR}/mongodb.pem to /tmp/certs/mongodb.pem with proper permissions"
else
    # If mongodb.pem doesn't exist, create a fallback using CA certificate
    if [ -f "${CERT_DEST_DIR}/mongodb-ca.crt" ]; then
        cat "${CERT_DEST_DIR}/mongodb-ca.crt" > "/tmp/certs/mongodb.pem"
        chmod 644 "/tmp/certs/mongodb.pem"
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Created fallback mongodb.pem from CA certificate"
    fi
fi

# Find and process agent certificates
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Finding and processing agent certificates..."

# Track certificates for HAProxy configuration
cert_paths=()

# Process MongoDB certificates if they exist
if [ -d "${CERT_MONGODB_SRC_DIR}" ]; then
    for cert in "${CERT_MONGODB_SRC_DIR}"/*.pem; do
        if [ -f "$cert" ]; then
            agent_id=$(basename "$cert" .pem)
            echo "[$(date '+%Y-%m-%d %H:%M:%S')] Found agent: ${agent_id}"
            cp "$cert" "${CERT_PRIVATE_DEST_DIR}/$(basename "$cert")"
            echo "[$(date '+%Y-%m-%d %H:%M:%S')] Copied ${cert} to ${CERT_PRIVATE_DEST_DIR}/$(basename "$cert")"
            cert_paths+=("${CERT_PRIVATE_DEST_DIR}/$(basename "$cert")")
        fi
    done
fi

# Process agent certificates if they exist
if [ -d "${CERT_AGENTS_SRC_DIR}" ]; then
    for agent_dir in "${CERT_AGENTS_SRC_DIR}"/*; do
        if [ -d "$agent_dir" ]; then
            agent_id=$(basename "$agent_dir")
            echo "[$(date '+%Y-%m-%d %H:%M:%S')] Found agent: ${agent_id}"
            
            # Create agent directory in destination
            mkdir -p "${CERT_AGENTS_DEST_DIR}/${agent_id}"
            
            # Copy all certificates for this agent
            for cert in "${agent_dir}"/*.pem; do
                if [ -f "$cert" ]; then
                    cert_name=$(basename "$cert")
                    cp "$cert" "${CERT_PRIVATE_DEST_DIR}/${cert_name}"
                    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Copied ${cert} to ${CERT_PRIVATE_DEST_DIR}/${cert_name}"
                    cert_paths+=("${CERT_PRIVATE_DEST_DIR}/${cert_name}")
                fi
            done
        fi
    done
fi

# Add mongodb.pem to cert paths if it exists
if [ -f "/tmp/certs/mongodb.pem" ]; then
    cert_paths+=("/tmp/certs/mongodb.pem")
fi

# Create certificate configuration file for HAProxy
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Certificate configuration file created at ${CONFIG_FILE}"
printf "%s\n" "${cert_paths[@]}" > "${CONFIG_FILE}"

# Check if Data Plane API configuration already includes the temporary directories
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Checking Data Plane API configuration..."

DPAPI_CONFIG="/usr/local/etc/haproxy/dataplaneapi.yml"

if [ -f "${DPAPI_CONFIG}" ]; then
    # Check if config contains our temporary directory
    if grep -q "${CERT_DEST_DIR}" "${DPAPI_CONFIG}"; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Data Plane API configuration already includes the temporary directories"
    else
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Updating Data Plane API configuration to use temporary directories"
        # This is a simplistic approach; in a real environment, you'd use a YAML parser
        sed -i "s|ssl_certs_dir:.*|ssl_certs_dir: ${CERT_DEST_DIR}|g" "${DPAPI_CONFIG}"
    fi
fi

# Set proper permissions
chown -R haproxy:haproxy "${CERT_DEST_DIR}" "${CERT_PRIVATE_DEST_DIR}" "${CERT_AGENTS_DEST_DIR}" "${CONFIG_FILE}" "/tmp/certs/mongodb.pem"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Certificate synchronization completed"
exit 0