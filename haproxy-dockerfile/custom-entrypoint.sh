#!/bin/bash
# Custom entrypoint script for HAProxy with Data Plane API

set -e

echo "[Entrypoint] Starting HAProxy with Data Plane API..."

# Configuration files
HAPROXY_CFG="/usr/local/etc/haproxy/haproxy.cfg"
HAPROXY_PID="/var/run/haproxy.pid"
HAPROXY_SOCK="/var/run/haproxy.sock"
DPAPI_CFG="/usr/local/etc/haproxy/dataplaneapi.yml"
DPAPI_LOG="/var/log/dataplaneapi.log"
DPAPI_HEALTH_URL="http://127.0.0.1:5555/v3/health"
CERT_PRECHECK="/usr/local/etc/haproxy/certificate-precheck.sh"
CERT_SYNC="/usr/local/bin/sync-certificates.sh"
DPAPI_INSTALL="/usr/local/bin/install-dataplaneapi.sh"

# Ensure data directories exist with proper permissions
mkdir -p /var/log /run

# Create log files with proper permissions
touch "$DPAPI_LOG"
chown haproxy:haproxy "$DPAPI_LOG"
chmod 644 "$DPAPI_LOG"

# Clean up old sockets/pid files
rm -f "$HAPROXY_SOCK" "$HAPROXY_PID"

# Run certificate pre-check script if it exists
if [ -f "$CERT_PRECHECK" ]; then
  echo "[Entrypoint] Running certificate pre-check..."
  bash "$CERT_PRECHECK"
else
  echo "[Entrypoint] Certificate pre-check script not found at $CERT_PRECHECK, skipping."
  # Perform minimal directory checks for certificates
  for dir in "/etc/ssl/certs" "/etc/ssl/private"; do
    if [ ! -d "$dir" ]; then
      echo "[Entrypoint] Creating certificate directory: $dir"
      mkdir -p "$dir"
      chmod 755 "$dir" 2>/dev/null || true
    fi
  done
fi

# Run certificate sync script
if [ -f "$CERT_SYNC" ]; then
  echo "[Entrypoint] Running certificate sync..."
  bash "$CERT_SYNC"
else
  echo "[Entrypoint][ERROR] Certificate sync script not found at $CERT_SYNC!"
  exit 1
fi

# Install Data Plane API
if [ -f "$DPAPI_INSTALL" ]; then
  echo "[Entrypoint] Installing Data Plane API..."
  bash "$DPAPI_INSTALL"
  
  # Check if install was successful
  if [ $? -ne 0 ]; then
    echo "[Entrypoint][ERROR] Data Plane API installation failed!"
    exit 1
  fi
else
  echo "[Entrypoint][ERROR] Data Plane API installation script not found at $DPAPI_INSTALL!"
  exit 1
fi

# Validate HAProxy configuration before starting
echo "[Entrypoint] Validating HAProxy configuration..."
if ! /usr/local/sbin/haproxy -c -f "$HAPROXY_CFG"; then
  echo "[Entrypoint][ERROR] Invalid HAProxy configuration! Exiting."
  exit 1
fi

# Start HAProxy in foreground with master-worker mode
echo "[Entrypoint] Starting HAProxy..."
/usr/local/sbin/haproxy -W -db -f "$HAPROXY_CFG" -p "$HAPROXY_PID" &
HAPROXY_PID_VALUE=$!

# Wait for HAProxy socket to be created
echo "[Entrypoint] Waiting for HAProxy socket..."
SOCKET_RETRIES=30
SOCKET_RETRY_INTERVAL=1
SOCKET_COUNTER=0

while [ ! -S "$HAPROXY_SOCK" ]; do
  if [ $SOCKET_COUNTER -ge $SOCKET_RETRIES ]; then
    echo "[Entrypoint][ERROR] HAProxy socket not found after $SOCKET_RETRIES seconds!"
    exit 1
  fi
  
  # Check if HAProxy process is still running
  if ! kill -0 $HAPROXY_PID_VALUE 2>/dev/null; then
    echo "[Entrypoint][ERROR] HAProxy process exited unexpectedly!"
    exit 1
  fi
  
  sleep $SOCKET_RETRY_INTERVAL
  SOCKET_COUNTER=$((SOCKET_COUNTER+1))
done

# Set proper permissions on socket
chown haproxy:haproxy "$HAPROXY_SOCK" 2>/dev/null || true
chmod 660 "$HAPROXY_SOCK" 2>/dev/null || true

echo "[Entrypoint] HAProxy started successfully."

# Start Data Plane API with retry mechanism
echo "[Entrypoint] Starting Data Plane API..."
DPAPI_MAX_RETRIES=3
DPAPI_RETRY_INTERVAL=5
DPAPI_RETRY_COUNT=0
DPAPI_HEALTHY=false

while [ $DPAPI_RETRY_COUNT -lt $DPAPI_MAX_RETRIES ]; do
  # Start Data Plane API as haproxy user
  su -s /bin/bash haproxy -c "/usr/local/bin/dataplaneapi -f $DPAPI_CFG >> $DPAPI_LOG 2>&1 &"
  DATAPLANEAPI_PID=$!
  
  # Wait for Data Plane API to become healthy
  echo "[Entrypoint] Waiting for Data Plane API to become healthy..."
  HEALTH_RETRIES=10
  HEALTH_RETRY_INTERVAL=1
  HEALTH_COUNTER=0
  
  while [ $HEALTH_COUNTER -lt $HEALTH_RETRIES ]; do
    if curl -s --fail "$DPAPI_HEALTH_URL" > /dev/null; then
      DPAPI_HEALTHY=true
      echo "[Entrypoint] Data Plane API is healthy."
      break
    fi
    
    # Check if Data Plane API process is still running
    if ! kill -0 $DATAPLANEAPI_PID 2>/dev/null; then
      echo "[Entrypoint][WARNING] Data Plane API process exited unexpectedly!"
      break
    fi
    
    sleep $HEALTH_RETRY_INTERVAL
    HEALTH_COUNTER=$((HEALTH_COUNTER+1))
  done
  
  if [ "$DPAPI_HEALTHY" = "true" ]; then
    break
  fi
  
  DPAPI_RETRY_COUNT=$((DPAPI_RETRY_COUNT+1))
  
  # If this wasn't the last attempt, kill the process and retry
  if [ $DPAPI_RETRY_COUNT -lt $DPAPI_MAX_RETRIES ]; then
    echo "[Entrypoint][WARNING] Data Plane API not healthy after $HEALTH_RETRIES seconds. Retrying..."
    
    # Dump logs for debugging
    echo "--- Data Plane API Log ---"
    tail -n 20 "$DPAPI_LOG"
    echo "--- End Data Plane API Log ---"
    
    # Kill process if still running
    if kill -0 $DATAPLANEAPI_PID 2>/dev/null; then
      kill -TERM $DATAPLANEAPI_PID
    fi
    
    # Run certificate sync again before retry
    echo "[Entrypoint] Re-running certificate sync before retry..."
    bash "$CERT_SYNC"
    
    sleep $DPAPI_RETRY_INTERVAL
  fi
done

if [ "$DPAPI_HEALTHY" != "true" ]; then
  echo "[Entrypoint][ERROR] Failed to start Data Plane API after $DPAPI_MAX_RETRIES attempts."
  
  # Dump logs for debugging
  echo "--- Data Plane API Log ---"
  tail -n 50 "$DPAPI_LOG"
  echo "--- End Data Plane API Log ---"
  
  # HAProxy needs to exit too so the container will restart
  kill -TERM $HAPROXY_PID_VALUE
  exit 1
fi

echo "[Entrypoint] All services started successfully."

# Setup signal handling
trap "kill -TERM $HAPROXY_PID_VALUE $DATAPLANEAPI_PID" SIGTERM SIGINT

# Keep the container running
wait $HAPROXY_PID_VALUE