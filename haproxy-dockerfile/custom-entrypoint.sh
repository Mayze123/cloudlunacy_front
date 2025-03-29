#!/bin/sh
set -e

echo "Starting HAProxy with custom configuration..."

# Copy the original haproxy.cfg to a temporary file
cp /usr/local/etc/haproxy/haproxy.cfg /tmp/haproxy.cfg

# Append Data Plane API configuration if not already present
if ! grep -q "userlist dataplaneapi" /tmp/haproxy.cfg; then
    echo "Adding Data Plane API configuration..."
    cat << EOF >> /tmp/haproxy.cfg

# Data Plane API User List
userlist dataplaneapi
    user ${HAPROXY_API_USER:-admin} insecure-password ${HAPROXY_API_PASS:-admin}

# Data Plane API Frontend
frontend dataplane_api
    bind *:5555
    stats enable
    stats uri /stats
    stats refresh 10s
    option httplog
    log global
    acl authenticated http_auth(dataplaneapi)
    http-request auth realm dataplane_api if !authenticated
    http-request use-service prometheus-exporter if { path /metrics }
    http-request use-service haproxy.http-errors status:500,429,503 if { path /health }
    http-request use-service haproxy.http-errors status:200 if { path_beg /v1 } authenticated
    http-request use-service haproxy.http-errors status:200 if { path_beg /v2 } authenticated
EOF
fi

echo "Starting HAProxy with configuration:"
head -n 20 /tmp/haproxy.cfg

# Run the original HAProxy entrypoint with our config
exec docker-entrypoint.sh haproxy -f /tmp/haproxy.cfg "$@" 