#!/bin/sh
set -e

echo "[Entrypoint] Starting CloudLunacy HAProxy with Data Plane API..."

# Ensure data directories exist with proper permissions
mkdir -p /etc/haproxy/dataplaneapi /var/lib/haproxy/backups /var/log/haproxy
mkdir -p /etc/haproxy/maps /etc/haproxy/spoe

# Create all required directories with proper permissions
chown -R haproxy:haproxy /etc/haproxy/dataplaneapi /var/lib/haproxy/backups /var/log/haproxy 
chown -R haproxy:haproxy /etc/haproxy/maps /etc/haproxy/spoe

# Prepare log files
touch /var/log/dataplaneapi.log
touch /var/log/haproxy-startup.log
chmod 644 /var/log/dataplaneapi.log /var/log/haproxy-startup.log
chown haproxy:haproxy /var/log/dataplaneapi.log /var/log/haproxy-startup.log

# Ensure errors directory and default error page
mkdir -p /etc/haproxy/errors
if [ ! -f "/etc/haproxy/errors/503.http" ]; then
  cat > /etc/haproxy/errors/503.http << EOF
HTTP/1.0 503 Service Unavailable
Cache-Control: no-cache
Connection: close
Content-Type: text/html

<!DOCTYPE html>
<html><head><title>Service Unavailable</title></head><body><h1>Service Temporarily Unavailable</h1></body></html>
EOF
fi

# Clean up old sockets
rm -f /var/run/haproxy.sock /tmp/haproxy.sock

# Check if dataplaneapi.yml exists and is readable
if [ ! -f "/usr/local/etc/haproxy/dataplaneapi.yml" ]; then
  echo "[Entrypoint] Copying dataplaneapi.yml to proper location..."
  cp /etc/haproxy/dataplaneapi.yml /usr/local/etc/haproxy/dataplaneapi.yml
  chmod 644 /usr/local/etc/haproxy/dataplaneapi.yml
  chown haproxy:haproxy /usr/local/etc/haproxy/dataplaneapi.yml
fi

# Validate configuration before starting
echo "[Entrypoint] Validating HAProxy configuration..."
if ! haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg; then
  echo "[Entrypoint][ERROR] Invalid HAProxy configuration! Exiting."
  exit 1
fi

# Handle shutdown
cleanup() {
  echo "[Entrypoint] Shutting down..."
  [ -n "$DATAPLANEAPI_PID" ] && kill -TERM $DATAPLANEAPI_PID 2>/dev/null || true
  [ -n "$HAPROXY_PID" ] && kill -TERM $HAPROXY_PID 2>/dev/null || true
  exit 0
}
trap cleanup TERM INT QUIT

# Start HAProxy
echo "[Entrypoint] Starting HAProxy..."
haproxy -W -db -f /usr/local/etc/haproxy/haproxy.cfg > /var/log/haproxy-startup.log 2>&1 &
HAPROXY_PID=$!

# Wait for HAProxy to start and create the socket
echo "[Entrypoint] Waiting for HAProxy socket..."
for i in $(seq 1 30); do
  if [ -S /var/run/haproxy.sock ]; then
    break
  fi
  if ! kill -0 $HAPROXY_PID 2>/dev/null; then
    echo "[Entrypoint][ERROR] HAProxy failed to start. See /var/log/haproxy-startup.log"
    cat /var/log/haproxy-startup.log
    exit 1
  fi
  sleep 1
done

# Ensure socket has proper permissions
if [ -S /var/run/haproxy.sock ]; then
  chmod 660 /var/run/haproxy.sock
  chown haproxy:haproxy /var/run/haproxy.sock
else
  echo "[Entrypoint][WARNING] HAProxy socket not found after 30 seconds"
fi

# Start Data Plane API
echo "[Entrypoint] Starting Data Plane API..."
dataplaneapi -f /usr/local/etc/haproxy/dataplaneapi.yml > /var/log/dataplaneapi.log 2>&1 &
DATAPLANEAPI_PID=$!

# Wait for Data Plane API to become healthy
echo "[Entrypoint] Waiting for Data Plane API to start..."
for i in $(seq 1 30); do
  if curl -s -f -o /dev/null http://localhost:5555/v3/health; then
    echo "[Entrypoint] Data Plane API is running."
    break
  fi
  if ! kill -0 $DATAPLANEAPI_PID 2>/dev/null; then
    echo "[Entrypoint][ERROR] Data Plane API failed to start. See /var/log/dataplaneapi.log"
    cat /var/log/dataplaneapi.log
    exit 1
  fi
  sleep 1
done

# Main process: wait on both PIDs
wait $HAPROXY_PID $DATAPLANEAPI_PID