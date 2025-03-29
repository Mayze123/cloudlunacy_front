#!/bin/sh
set -e

# Wait until HAProxy is ready (config file is available)
CONFIG_FILE="/usr/local/etc/haproxy/haproxy.cfg"
while [ ! -f "$CONFIG_FILE" ]; do
    echo "Waiting for HAProxy config file..."
    sleep 1
done

# Environment variables for Data Plane API
HAPROXY_API_USER=${HAPROXY_API_USER:-admin}
HAPROXY_API_PASS=${HAPROXY_API_PASS:-admin}

# Export these variables so dataplaneapi can use them
export HAPROXY_API_USER
export HAPROXY_API_PASS

echo "Starting Data Plane API as ${HAPROXY_API_USER}..."
exec dataplaneapi --host 0.0.0.0 --port 5555 \
    --haproxy-bin /usr/local/sbin/haproxy \
    --config-file "$CONFIG_FILE" \
    --reload-cmd "kill -SIGUSR2 1" \
    --reload-delay 5 \
    --userlist dataplaneapi \
    --log-level info 