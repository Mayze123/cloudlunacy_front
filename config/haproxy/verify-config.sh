#!/bin/sh
set -e

echo "Verifying HAProxy configuration..."

# Path to HAProxy configuration
CONFIG_FILE="/usr/local/etc/haproxy/haproxy.cfg"
BACKUP_DIR="/var/lib/haproxy/backups"

# Create backup directory if it doesn't exist
mkdir -p $BACKUP_DIR

# Backup current config before verification
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
cp $CONFIG_FILE "${BACKUP_DIR}/haproxy_${TIMESTAMP}.cfg"
echo "Configuration backed up to ${BACKUP_DIR}/haproxy_${TIMESTAMP}.cfg"

# Run HAProxy with -c flag to check configuration
if haproxy -c -f $CONFIG_FILE; then
    echo "✅ HAProxy configuration is valid!"
    exit 0
else
    echo "❌ HAProxy configuration is invalid!"
    echo "Last working configuration is available at ${BACKUP_DIR}/haproxy_${TIMESTAMP}.cfg"
    exit 1
fi 