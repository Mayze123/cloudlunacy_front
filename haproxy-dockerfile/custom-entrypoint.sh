#!/bin/sh
set -e

echo "[Entrypoint] Starting CloudLunacy HAProxy with Data Plane API..."

# Configuration files
HAPROXY_CFG="/usr/local/etc/haproxy/haproxy.cfg"
HAPROXY_PID="/var/run/haproxy.pid"
HAPROXY_SOCK="/var/run/haproxy.sock"
DPAPI_CFG="/usr/local/etc/haproxy/dataplaneapi.yml"
DPAPI_LOG="/var/log/dataplaneapi.log"
HAPROXY_STARTUP_LOG="/var/log/haproxy-startup.log"
DPAPI_HEALTH_URL="http://127.0.0.1:5555/v3/health" # Use loopback for health check

# Ensure data directories exist with proper permissions
mkdir -p /etc/haproxy/dataplaneapi /var/lib/haproxy/backups /var/log /run
mkdir -p /etc/haproxy/maps /etc/haproxy/spoe /etc/haproxy/errors

# Create/chown essential files and directories
touch "$DPAPI_LOG" "$HAPROXY_STARTUP_LOG"
chown -R haproxy:haproxy /etc/haproxy /var/lib/haproxy /var/log
chmod 640 "$DPAPI_LOG" "$HAPROXY_STARTUP_LOG" # Slightly more secure
chmod 640 "$DPAPI_CFG" # Config file permissions

# Ensure default error page
if [ ! -f "/etc/haproxy/errors/503.http" ]; then
  cat > /etc/haproxy/errors/503.http << EOF
HTTP/1.0 503 Service Unavailable
Cache-Control: no-cache
Connection: close
Content-Type: text/html

<!DOCTYPE html>
<html><head><title>Service Unavailable</title></head><body><h1>Service Temporarily Unavailable</h1></body></html>
EOF
  chown haproxy:haproxy /etc/haproxy/errors/503.http
  chmod 644 /etc/haproxy/errors/503.http
fi

# Clean up old sockets/pid files
rm -f "$HAPROXY_SOCK" "$HAPROXY_PID"

# Check the Data Plane API configuration file exists
if [ ! -f "$DPAPI_CFG" ]; then
  echo "[Entrypoint][ERROR] Data Plane API configuration file '$DPAPI_CFG' not found!"
  exit 1
fi

# Validate HAProxy configuration before starting
echo "[Entrypoint] Validating HAProxy configuration '$HAPROXY_CFG'..."
if ! haproxy -c -f "$HAPROXY_CFG"; then
  echo "[Entrypoint][ERROR] Invalid HAProxy configuration! Exiting."
  exit 1
fi
echo "[Entrypoint] HAProxy configuration validated successfully."

# Handle shutdown
cleanup() {
  echo "[Entrypoint] Shutting down..."
  if [ -n "$DATAPLANEAPI_PID" ] && kill -0 "$DATAPLANEAPI_PID" >/dev/null 2>&1; then
    kill -TERM "$DATAPLANEAPI_PID"
    wait "$DATAPLANEAPI_PID" 2>/dev/null || true
  fi
   if [ -n "$HAPROXY_PID" ] && kill -0 "$HAPROXY_PID" >/dev/null 2>&1; then
    kill -TERM "$HAPROXY_PID"
    wait "$HAPROXY_PID" 2>/dev/null || true
  fi
  echo "[Entrypoint] Shutdown complete."
  exit 0
}
trap cleanup TERM INT QUIT

# Start HAProxy
# Use -W for master-worker mode (recommended), -db to disable background daemon mode for container
echo "[Entrypoint] Starting HAProxy..."
haproxy -W -db -f "$HAPROXY_CFG" -p "$HAPROXY_PID" > "$HAPROXY_STARTUP_LOG" 2>&1 &
HAPROXY_PID_BG=$! # Get PID of the backgrounded HAProxy master process

# Wait for HAProxy to start and create the socket and PID file
echo "[Entrypoint] Waiting for HAProxy socket '$HAPROXY_SOCK' and PID file '$HAPROXY_PID'..."
WAIT_TIMEOUT=30
SECONDS=0
while [ $SECONDS -lt $WAIT_TIMEOUT ]; do
  if [ -S "$HAPROXY_SOCK" ] && [ -f "$HAPROXY_PID" ]; then
     echo "[Entrypoint] HAProxy socket and PID file found."
     # HAProxy should create these with correct permissions due to 'user' directive
     # Optionally, enforce permissions:
     # chmod 660 "$HAPROXY_SOCK"
     # chown haproxy:haproxy "$HAPROXY_SOCK" "$HAPROXY_PID"
     break
  fi
  # Check if HAProxy process died
  if ! kill -0 $HAPROXY_PID_BG > /dev/null 2>&1; then
     echo "[Entrypoint][ERROR] HAProxy failed to start or create socket/pid."
     echo "--- HAProxy Startup Log ($HAPROXY_STARTUP_LOG) ---"
     cat "$HAPROXY_STARTUP_LOG" || echo "Log file empty or not readable."
     echo "--- End HAProxy Startup Log ---"
     exit 1
  fi
  sleep 1
  SECONDS=$((SECONDS + 1))
done

if [ $SECONDS -ge $WAIT_TIMEOUT ]; then
  echo "[Entrypoint][ERROR] Timeout waiting for HAProxy socket/pid after $WAIT_TIMEOUT seconds."
  echo "--- HAProxy Startup Log ($HAPROXY_STARTUP_LOG) ---"
  cat "$HAPROXY_STARTUP_LOG" || echo "Log file empty or not readable."
  echo "--- End HAProxy Startup Log ---"
  exit 1
fi

# Start Data Plane API
echo "[Entrypoint] Starting Data Plane API..."
# Run DPAPI as haproxy user for better security, if possible and paths allow
# Consider: su-exec haproxy dataplaneapi -f "$DPAPI_CFG" > "$DPAPI_LOG" 2>&1 &
# For now, run as root (default) which should have access after chown
dataplaneapi -f "$DPAPI_CFG" >> "$DPAPI_LOG" 2>&1 &
DATAPLANEAPI_PID=$!

# Wait for Data Plane API to become healthy
echo "[Entrypoint] Waiting for Data Plane API at '$DPAPI_HEALTH_URL'..."
WAIT_TIMEOUT=30
SECONDS=0
HEALTHY=false
while [ $SECONDS -lt $WAIT_TIMEOUT ]; do
  # Use curl with loopback address, fail silently, short timeout
  if curl --fail -s -o /dev/null --max-time 2 "$DPAPI_HEALTH_URL"; then
    echo "[Entrypoint] Data Plane API is running and healthy."
    HEALTHY=true
    break
  fi
  # Check if DPAPI process died
  if ! kill -0 $DATAPLANEAPI_PID > /dev/null 2>&1; then
     echo "[Entrypoint][ERROR] Data Plane API failed to start."
     break # Exit loop, will report error below
  fi
  sleep 1
  SECONDS=$((SECONDS + 1))
done

if [ "$HEALTHY" != "true" ]; then
  echo "[Entrypoint][ERROR] Data Plane API did not become healthy after $WAIT_TIMEOUT seconds or failed to start."
  echo "--- Data Plane API Log ($DPAPI_LOG) ---"
  cat "$DPAPI_LOG" || echo "Log file empty or not readable."
  echo "--- End Data Plane API Log ---"
  # Attempt to kill potentially lingering DPAPI process before exiting
  kill -TERM $DATAPLANEAPI_PID 2>/dev/null || true
  exit 1
fi

echo "[Entrypoint] HAProxy and Data Plane API started successfully. Monitoring processes."

# Wait indefinitely for either process to exit
# Use wait -n in bash 4.3+ for cleaner exit, or loop+sleep for older sh
# Simple wait for both PIDs:
wait $HAPROXY_PID_BG $DATAPLANEAPI_PID
EXIT_CODE=$?
echo "[Entrypoint] A process exited with code $EXIT_CODE. Initiating shutdown..."

# Call cleanup explicitly in case wait finishes before signal trap
cleanup