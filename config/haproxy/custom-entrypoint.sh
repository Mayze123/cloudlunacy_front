#!/bin/sh
set -e

echo "Starting HAProxy with Data Plane API"

# Check if dataplaneapi command exists
if command -v dataplaneapi >/dev/null 2>&1; then
    echo "Data Plane API is available"
else
    echo "Data Plane API is not installed, installing now..."
    # Use the binary that should be included in the image
    if [ -f "/usr/sbin/dataplaneapi" ]; then
        echo "Found Data Plane API binary at /usr/sbin/dataplaneapi"
    else
        echo "ERROR: Data Plane API binary not found in the image"
        exit 1
    fi
fi

# Start Data Plane API in the background
echo "Starting Data Plane API in the background..."
if [ -f "/usr/local/etc/haproxy/dataplaneapi.yml" ]; then
    echo "Using Data Plane API config at /usr/local/etc/haproxy/dataplaneapi.yml"
    dataplaneapi -c /usr/local/etc/haproxy/dataplaneapi.yml &
else
    echo "Starting Data Plane API with default config"
    dataplaneapi --userlist dataplaneapi --host 0.0.0.0 --port 5555 --haproxy-bin /usr/sbin/haproxy --config-file /usr/local/etc/haproxy/haproxy.cfg &
fi

# Wait a moment for Data Plane API to start
sleep 2

# Start HAProxy
echo "Starting HAProxy..."
exec docker-entrypoint.sh "$@" 