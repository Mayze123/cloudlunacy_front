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

# Skip package installation since it requires root privileges
echo "Using pre-installed utilities in the container"

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