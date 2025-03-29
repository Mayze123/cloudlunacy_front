#!/bin/sh
set -e

# Path to the template and final config
TEMPLATE_CONFIG="/usr/local/etc/haproxy/haproxy.cfg"
FINAL_CONFIG="/tmp/haproxy-final.cfg"

# Certificate paths
CERT_FILE="/etc/ssl/certs/mongodb.crt"
KEY_FILE="/etc/ssl/private/mongodb.key"

# Create dataplaneapi directory if it doesn't exist
mkdir -p /etc/haproxy/dataplaneapi

# Install dependencies for Alpine Linux
if ! command -v curl >/dev/null 2>&1; then
    echo "Installing curl..."
    apk add --no-cache curl
fi

if ! command -v wget >/dev/null 2>&1; then
    echo "Installing wget..."
    apk add --no-cache wget
fi

# Install build dependencies for Data Plane API
apk add --no-cache ca-certificates tar

# Install the Data Plane API
mkdir -p /tmp/dataplaneapi
cd /tmp/dataplaneapi
wget -q https://github.com/haproxytech/dataplaneapi/releases/download/v2.8.0/dataplaneapi_2.8.0_Linux_x86_64.tar.gz
tar xf dataplaneapi_2.8.0_Linux_x86_64.tar.gz
cp dataplaneapi /usr/local/bin/
chmod +x /usr/local/bin/dataplaneapi

# Environment variables for Data Plane API
export HAPROXY_API_USER=${HAPROXY_API_USER:-admin}
export HAPROXY_API_PASS=${HAPROXY_API_PASS:-admin}

# Start Data Plane API in the background
echo "Starting Data Plane API..."
nohup dataplaneapi --host 0.0.0.0 --port 5555 \
    --haproxy-bin /usr/local/sbin/haproxy \
    --config-file $FINAL_CONFIG \
    --reload-cmd "kill -SIGUSR2 1" \
    --reload-delay 5 \
    --userlist dataplaneapi \
    --log-level info \
    > /var/log/dataplaneapi.log 2>&1 &

# Check if both certificate and key exist
if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
    echo "MongoDB SSL certificates found. Configuring HAProxy with SSL support."
    
    # Step 1: First handle the bind line replacement using basic shell redirects
    sed 's|bind \*:27017|bind *:27017 ssl crt /etc/ssl/certs/mongodb.crt key /etc/ssl/private/mongodb.key|g' $TEMPLATE_CONFIG > $FINAL_CONFIG
    
    # Step 2: Now handle the SNI line uncommenting using basic grep and a temp file
    sed 's|# http-request set-var|http-request set-var|g' $FINAL_CONFIG > /tmp/haproxy-temp.cfg
    mv /tmp/haproxy-temp.cfg $FINAL_CONFIG
else
    echo "MongoDB SSL certificates not found. Configuring HAProxy without SSL support."
    # Just copy the template as-is
    cat $TEMPLATE_CONFIG > $FINAL_CONFIG
fi

# Print config for debugging
echo "Configuration generated:"
head -n 20 $FINAL_CONFIG

# Execute the original entrypoint with our final config
exec docker-entrypoint.sh haproxy -f $FINAL_CONFIG "$@" 