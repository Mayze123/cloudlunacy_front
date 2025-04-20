#!/bin/bash
# Custom entrypoint script for HAProxy with Data Plane API

set -e

echo "[Entrypoint] Starting HAProxy with Data Plane API..."

# Configuration files
HAPROXY_CFG="/usr/local/etc/haproxy/haproxy.cfg"
HAPROXY_PID="/var/run/haproxy.pid"
HAPROXY_SOCK="/var/run/haproxy.sock"
DPAPI_CFG="/usr/local/etc/haproxy/dataplaneapi.yml"
DPAPI_CFG_JSON="/usr/local/etc/haproxy/dataplaneapi.json"
DPAPI_LOG="/var/log/dataplaneapi.log"
DPAPI_HEALTH_URL="http://127.0.0.1:5555/health"
CERT_PRECHECK="/usr/local/etc/haproxy/certificate-precheck.sh"
CERT_SYNC="/usr/local/bin/sync-certificates.sh"
DPAPI_INSTALL="/usr/local/bin/install-dataplaneapi.sh"
MONGODB_CERT="/etc/ssl/certs/mongodb.pem"
MONGODB_CERT_TMP="/tmp/certs/mongodb.pem"

# Ensure data directories exist with proper permissions
mkdir -p /var/log /run /var/run 
chmod 755 /var/run 2>/dev/null || true

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

# Handle mongodb.pem certificate with read-only filesystem
echo "[Entrypoint] Checking readability of SSL certificate $MONGODB_CERT for user haproxy..."
if [ -f "$MONGODB_CERT" ]; then
  if su -s /bin/bash haproxy -c "test -r $MONGODB_CERT"; then
    echo "[Entrypoint] Certificate $MONGODB_CERT is readable by haproxy user."
  else
    echo "[Entrypoint][ERROR] SSL certificate $MONGODB_CERT is not readable by user haproxy!"
    ls -l "$MONGODB_CERT"
    
    echo "[Entrypoint] Creating a readable copy in a writable location..."
    # Create a copy of the certificate in the temporary writable directory
    cp "$MONGODB_CERT" "$MONGODB_CERT_TMP" 2>/dev/null
    
    # Try to set permissions on the copy
    if [ -f "$MONGODB_CERT_TMP" ]; then
      chmod 644 "$MONGODB_CERT_TMP" 2>/dev/null
      chown haproxy:haproxy "$MONGODB_CERT_TMP" 2>/dev/null
      
      # Verify if the copy is readable
      if su -s /bin/bash haproxy -c "test -r $MONGODB_CERT_TMP"; then
        echo "[Entrypoint] Successfully created readable copy at $MONGODB_CERT_TMP"
        
        # Create a symlink if possible to maintain compatibility with scripts looking for the original path
        if [ -w "$(dirname "$MONGODB_CERT")" ]; then
          ln -sf "$MONGODB_CERT_TMP" "$MONGODB_CERT" 2>/dev/null || true
        fi
        
        # Update the HAProxy configuration to use the new certificate path
        sed -i "s|$MONGODB_CERT|$MONGODB_CERT_TMP|g" "$HAPROXY_CFG" 2>/dev/null || true
      else
        echo "[Entrypoint][ERROR] Failed to create a readable certificate copy!"
      fi
    else
      echo "[Entrypoint][ERROR] Failed to copy certificate to writable location!"
    fi
  fi
else
  echo "[Entrypoint] MongoDB certificate $MONGODB_CERT does not exist, creating a dummy certificate..."
  
  # If mongodb.pem doesn't exist, create a symlink to the CA certificate as a fallback
  if [ -f "/etc/ssl/certs/ca.crt" ] && [ -f "/tmp/certs/certs/mongodb-ca.crt" ]; then
    # Create a temporary combined file in writable location
    cat "/tmp/certs/certs/mongodb-ca.crt" > "$MONGODB_CERT_TMP" 2>/dev/null
    chmod 644 "$MONGODB_CERT_TMP" 2>/dev/null
    chown haproxy:haproxy "$MONGODB_CERT_TMP" 2>/dev/null
    
    echo "[Entrypoint] Created fallback certificate at $MONGODB_CERT_TMP"
    
    # Update the HAProxy configuration to use the new certificate path
    sed -i "s|$MONGODB_CERT|$MONGODB_CERT_TMP|g" "$HAPROXY_CFG" 2>/dev/null || true
  else
    echo "[Entrypoint][WARN] No CA certificate found to create fallback mongodb.pem"
  fi
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
    echo "[Entrypint][ERROR] HAProxy process exited unexpectedly!"
    exit 1
  fi
  
  sleep $SOCKET_RETRY_INTERVAL
  SOCKET_COUNTER=$((SOCKET_COUNTER+1))
done

# Set proper permissions on socket
chown haproxy:haproxy "$HAPROXY_SOCK" 2>/dev/null || true
chmod 660 "$HAPROXY_SOCK" 2>/dev/null || true

echo "[Entrypoint] HAProxy started successfully."

# Verify config files exist
if [ ! -f "$DPAPI_CFG" ] && [ ! -f "$DPAPI_CFG_JSON" ]; then
  echo "[Entrypoint][ERROR] No Data Plane API config files found!"
  exit 1
fi

# Make sure config is readable
if [ -f "$DPAPI_CFG" ]; then
  chmod 644 "$DPAPI_CFG"
  chown haproxy:haproxy "$DPAPI_CFG"
fi

if [ -f "$DPAPI_CFG_JSON" ]; then
  chmod 644 "$DPAPI_CFG_JSON"
  chown haproxy:haproxy "$DPAPI_CFG_JSON"
fi

# Start Data Plane API with retry mechanism
echo "[Entrypoint] Starting Data Plane API..."
DPAPI_MAX_RETRIES=3
DPAPI_RETRY_INTERVAL=5
DPAPI_RETRY_COUNT=0
DPAPI_HEALTHY=false

while [ $DPAPI_RETRY_COUNT -lt $DPAPI_MAX_RETRIES ]; do
  # Truncate log file to avoid confusion with previous errors
  : > "$DPAPI_LOG"
  
  # Start Data Plane API - try YAML config first, fall back to JSON if it fails
  if [ -f "$DPAPI_CFG" ]; then
    echo "[Entrypoint] Starting Data Plane API with YAML config (attempt $((DPAPI_RETRY_COUNT+1))/${DPAPI_MAX_RETRIES})..."
    su -s /bin/bash haproxy -c "/usr/local/bin/dataplaneapi -f $DPAPI_CFG >> $DPAPI_LOG 2>&1 &"
  else
    echo "[Entrypoint] Starting Data Plane API with JSON config (attempt $((DPAPI_RETRY_COUNT+1))/${DPAPI_MAX_RETRIES})..."
    su -s /bin/bash haproxy -c "/usr/local/bin/dataplaneapi -c $DPAPI_CFG_JSON >> $DPAPI_LOG 2>&1 &"
  fi
  DATAPLANEAPI_PID=$!
  
  # Wait a moment for process to initialize
  sleep 3
  
  # Check if process started successfully
  if ! kill -0 $DATAPLANEAPI_PID 2>/dev/null; then
    echo "[Entrypoint][ERROR] Data Plane API process failed to start."
    cat "$DPAPI_LOG"
    
    # If YAML config failed, try JSON as fallback
    if [ -f "$DPAPI_CFG_JSON" ] && [ -f "$DPAPI_CFG" ]; then
      echo "[Entrypoint] Trying with JSON config as fallback..."
      su -s /bin/bash haproxy -c "/usr/local/bin/dataplaneapi -c $DPAPI_CFG_JSON >> $DPAPI_LOG 2>&1 &"
      DATAPLANEAPI_PID=$!
      sleep 3
      
      if ! kill -0 $DATAPLANEAPI_PID 2>/dev/null; then
        echo "[Entrypoint][ERROR] Data Plane API process failed to start with JSON config too."
        cat "$DPAPI_LOG"
      fi
    fi
    
    DPAPI_RETRY_COUNT=$((DPAPI_RETRY_COUNT+1))
    if [ $DPAPI_RETRY_COUNT -lt $DPAPI_MAX_RETRIES ]; then
      echo "[Entrypoint] Retrying in $DPAPI_RETRY_INTERVAL seconds..."
      sleep $DPAPI_RETRY_INTERVAL
    fi
    continue
  fi
  
  # Wait for Data Plane API to become healthy
  echo "[Entrypoint] Waiting for Data Plane API to become healthy..."
  HEALTH_RETRIES=20
  HEALTH_RETRY_INTERVAL=2
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
      cat "$DPAPI_LOG"
      break
    fi
    
    echo "[Entrypoint] Waiting for API to start... (${HEALTH_COUNTER}/${HEALTH_RETRIES})"
    sleep $HEALTH_RETRY_INTERVAL
    HEALTH_COUNTER=$((HEALTH_COUNTER+1))
  done
  
  if [ "$DPAPI_HEALTHY" = "true" ]; then
    break
  fi
  
  DPAPI_RETRY_COUNT=$((DPAPI_RETRY_COUNT+1))
  
  # If this wasn't the last attempt, kill the process and retry
  if [ $DPAPI_RETRY_COUNT -lt $DPAPI_MAX_RETRIES ]; then
    echo "[Entrypoint][WARNING] Data Plane API not healthy after $HEALTH_RETRIES attempts. Retrying..."
    
    # Dump logs for debugging
    echo "--- Data Plane API Log ---"
    cat "$DPAPI_LOG"
    echo "--- End Data Plane API Log ---"
    
    # Kill process if still running
    if kill -0 $DATAPLANEAPI_PID 2>/dev/null; then
      kill -TERM $DATAPLANEAPI_PID
      sleep 1
    fi
    
    # Re-run install to ensure clean setup for next attempt
    echo "[Entrypoint] Re-running Data Plane API installation before retry..."
    bash "$DPAPI_INSTALL"
    
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
  cat "$DPAPI_LOG"
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