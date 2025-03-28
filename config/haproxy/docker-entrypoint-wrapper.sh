#!/bin/sh
set -e

# Path to the template and final config
TEMPLATE_CONFIG="/usr/local/etc/haproxy/haproxy.cfg"
FINAL_CONFIG="/tmp/haproxy-final.cfg"

# Certificate paths
CERT_FILE="/etc/ssl/certs/mongodb.crt"
KEY_FILE="/etc/ssl/private/mongodb.key"

# Check if both certificate and key exist
if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
    echo "MongoDB SSL certificates found. Configuring HAProxy with SSL support."
    # Use grep and echo to create a new config instead of modifying the template directly
    cat $TEMPLATE_CONFIG | sed 's|bind \*:27017|bind *:27017 ssl crt /etc/ssl/certs/mongodb.crt key /etc/ssl/private/mongodb.key|g' | sed 's|# http-request set-var(txn.agent_id) req.ssl_sni,field(1,'\''.'\'\')|http-request set-var(txn.agent_id) req.ssl_sni,field(1,'\''.'\'\')|g' > $FINAL_CONFIG
else
    echo "MongoDB SSL certificates not found. Configuring HAProxy without SSL support."
    # Just copy the template as-is
    cat $TEMPLATE_CONFIG > $FINAL_CONFIG
fi

# Execute the original entrypoint with our final config
exec docker-entrypoint.sh haproxy -f $FINAL_CONFIG "$@" 