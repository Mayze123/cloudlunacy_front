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
CERT_PRECHECK="/usr/local/etc/haproxy/certificate-precheck.sh"
CERT_SYNC="/usr/local/bin/sync-certificates.sh"

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

# Run certificate pre-check script if it exists
if [ -f "$CERT_PRECHECK" ]; then
  echo "[Entrypoint] Running certificate pre-check..."
  chmod +x "$CERT_PRECHECK"
  "$CERT_PRECHECK"
else
  echo "[Entrypoint] Certificate pre-check script not found at $CERT_PRECHECK, skipping."
  # Perform minimal directory checks for certificates
  for dir in "/etc/ssl/certs" "/etc/ssl/private"; do
    if [ ! -d "$dir" ]; then
      echo "[Entrypoint] Creating certificate directory: $dir"
      mkdir -p "$dir"
      chmod 755 "$dir"
    fi
  done
fi

# Run certificate sync script if it exists
if [ -f "$CERT_SYNC" ]; then
  echo "[Entrypoint] Running certificate sync..."
  chmod +x "$CERT_SYNC"
  "$CERT_SYNC"
else
  echo "[Entrypoint] Certificate sync script not found at $CERT_SYNC, skipping."
fi

# Setup temporary certificate directories to ensure Data Plane API has writeable locations
mkdir -p /tmp/certs/certs /tmp/certs/private /tmp/certs/agents
chmod 755 /tmp/certs/certs
chmod 700 /tmp/certs/private

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
  if [ -n "$DATAPLANEAPI_PID" ] && kill -0 "$DATAPLANEAPI_PID" 2>/dev/null; then
    kill -TERM "$DATAPLANEAPI_PID" 2>/dev/null || true
    wait "$DATAPLANEAPI_PID" 2>/dev/null || true
  fi
   if [ -n "$HAPROXY_PID" ] && kill -0 "$HAPROXY_PID" 2>/dev/null; then
    kill -TERM "$HAPROXY_PID" 2>/dev/null || true
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

# Start Data Plane API with retry mechanism
echo "[Entrypoint] Starting Data Plane API..."
# Track retries and whether DPAPI started successfully
DPAPI_RETRIES=3
DPAPI_SUCCESS=false

while [ $DPAPI_RETRIES -gt 0 ] && [ "$DPAPI_SUCCESS" != "true" ]; do
  # Run DPAPI
  dataplaneapi -f "$DPAPI_CFG" >> "$DPAPI_LOG" 2>&1 &
  DATAPLANEAPI_PID=$!

  # Wait for Data Plane API to become healthy
  echo "[Entrypoint] Waiting for Data Plane API at '$DPAPI_HEALTH_URL'..."
  WAIT_TIMEOUT=15
  SECONDS=0
  HEALTHY=false
  while [ $SECONDS -lt $WAIT_TIMEOUT ]; do
    # Use curl with loopback address, fail silently, short timeout
    if curl --fail -s -o /dev/null --max-time 2 "$DPAPI_HEALTH_URL"; then
      echo "[Entrypoint] Data Plane API is running and healthy."
      HEALTHY=true
      DPAPI_SUCCESS=true
      break
    fi
    # Check if DPAPI process died
    if ! kill -0 $DATAPLANEAPI_PID 2>/dev/null; then
       echo "[Entrypoint][WARNING] Data Plane API failed to start."
       break # Exit loop, will retry
    fi
    sleep 1
    SECONDS=$((SECONDS + 1))
  done

  if [ "$HEALTHY" != "true" ]; then
    DPAPI_RETRIES=$((DPAPI_RETRIES - 1))
    echo "[Entrypoint][WARNING] Data Plane API did not become healthy after $WAIT_TIMEOUT seconds. Retries left: $DPAPI_RETRIES"
    echo "--- Data Plane API Log ($DPAPI_LOG) ---"
    tail -n 50 "$DPAPI_LOG" || echo "Log file empty or not readable."
    echo "--- End Data Plane API Log ---"
    
    # Kill the process if it's still running
    if kill -0 $DATAPLANEAPI_PID 2>/dev/null; then
      kill -TERM $DATAPLANEAPI_PID 2>/dev/null || true
      wait $DATAPLANEAPI_PID 2>/dev/null || true
    fi
    
    if [ $DPAPI_RETRIES -gt 0 ]; then
      echo "[Entrypoint] Retrying Data Plane API startup in 5 seconds..."
      sleep 5
      
      # Run certificate sync again before retrying (this can fix certificate issues)
      if [ -f "$CERT_SYNC" ]; then
        echo "[Entrypoint] Re-running certificate sync before retry..."
        "$CERT_SYNC"
      fi
    fi
  fi
done

# Continue even if Data Plane API failed
if [ "$DPAPI_SUCCESS" != "true" ]; then
  echo "[Entrypoint][WARNING] Data Plane API failed to start after multiple attempts."
  echo "[Entrypoint][WARNING] Continuing with HAProxy only. Some dynamic configuration features will be unavailable."
  echo "[Entrypoint][WARNING] HAProxy will continue to function with its current configuration."
  
  # We continue without DPAPI - HAProxy will still work, but without dynamic reconfiguration
  DATAPLANEAPI_PID=""
  
  # Create a flag file to indicate DPAPI failure for monitoring
  touch /var/run/dpapi_failed
else
  # Remove the flag file if it exists
  rm -f /var/run/dpapi_failed
fi

echo "[Entrypoint] HAProxy started successfully. Monitoring processes."

# If DPAPI started, monitor both processes, otherwise just HAProxy
if [ -n "$DATAPLANEAPI_PID" ]; then
  # Wait for either process to exit
  # Use simple loop to check both processes since wait -n may not be available in all shell versions
  while kill -0 $HAPROXY_PID_BG 2>/dev/null && kill -0 $DATAPLANEAPI_PID 2>/dev/null; do
    # Run certificate sync periodically to ensure up-to-date certificates
    if [ -f "$CERT_SYNC" ] && [ -f "/var/run/haproxy.pid" ]; then
      echo "[Entrypoint] Running periodic certificate sync..."
      "$CERT_SYNC" > /dev/null 2>&1
    fi
    sleep 300  # Run certificate sync every 5 minutes
  done
  
  echo "[Entrypoint] A process exited. Initiating shutdown..."
else
  # Just wait for HAProxy to exit
  wait $HAPROXY_PID_BG
  echo "[Entrypoint] HAProxy exited. Initiating shutdown..."
fi

# Call cleanup explicitly in case wait finishes before signal trap
cleanup