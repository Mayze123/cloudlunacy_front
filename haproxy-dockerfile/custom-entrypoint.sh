#!/bin/sh
set -e

echo "Starting CloudLunacy HAProxy with Data Plane API..."

# Ensure data directories exist with proper permissions
mkdir -p /etc/haproxy/dataplaneapi
mkdir -p /var/lib/haproxy/backups
mkdir -p /var/log/haproxy
chown -R haproxy:haproxy /etc/haproxy/dataplaneapi /var/lib/haproxy/backups /var/log/haproxy

# Log file preparation
touch /var/log/dataplaneapi.log
touch /var/log/haproxy-startup.log
chmod 644 /var/log/dataplaneapi.log /var/log/haproxy-startup.log
chown haproxy:haproxy /var/log/dataplaneapi.log /var/log/haproxy-startup.log

# Ensure errors directory exists
if [ ! -d "/etc/haproxy/errors" ]; then
  echo "Creating errors directory..."
  mkdir -p /etc/haproxy/errors
fi

# Create default error pages if they don't exist
if [ ! -f "/etc/haproxy/errors/503.http" ]; then
  echo "Creating default 503 error page..."
  cat > /etc/haproxy/errors/503.http << EOF
HTTP/1.0 503 Service Unavailable
Cache-Control: no-cache
Connection: close
Content-Type: text/html

<!DOCTYPE html>
<html>
<head>
    <title>Service Unavailable</title>
    <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
        .container { max-width: 600px; margin: 0 auto; }
        h1 { color: #e74c3c; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Service Temporarily Unavailable</h1>
        <p>We apologize for the inconvenience. The service is currently undergoing maintenance.</p>
        <p>Please try again later.</p>
    </div>
</body>
</html>
EOF
fi

# Make sure the HAProxy socket is accessible
mkdir -p /var/run
chmod 755 /var/run
rm -f /var/run/haproxy.sock
rm -f /tmp/haproxy.sock

# Validate configuration first before starting anything
echo "Validating HAProxy configuration..."
if ! haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg; then
  echo "ERROR: HAProxy configuration is invalid! Exiting."
  exit 1
fi

# Function to handle container shutdown
cleanup() {
  echo "Shutting down services..."
  # Signal Data Plane API to stop (if it's running)
  if [ -n "$DATAPLANEAPI_PID" ] && kill -0 $DATAPLANEAPI_PID 2>/dev/null; then
    echo "Stopping Data Plane API (PID: $DATAPLANEAPI_PID)"
    kill -TERM $DATAPLANEAPI_PID 2>/dev/null || true
  fi
  
  # Signal HAProxy to stop (if it's running)
  if [ -n "$HAPROXY_PID" ] && kill -0 $HAPROXY_PID 2>/dev/null; then
    echo "Stopping HAProxy (PID: $HAPROXY_PID)"
    kill -TERM $HAPROXY_PID 2>/dev/null || true
  fi
  
  echo "Services stopped. Exiting."
  exit 0
}

# Set up signal handling for clean shutdown
trap cleanup TERM INT QUIT

# Start HAProxy first because Data Plane API needs the sockets
echo "Starting HAProxy first..."
haproxy -W -db -f /usr/local/etc/haproxy/haproxy.cfg > /var/log/haproxy-startup.log 2>&1 &
HAPROXY_PID=$!
echo "HAProxy started with PID $HAPROXY_PID"

# Wait briefly to ensure HAProxy creates its sockets
sleep 3
if ! kill -0 $HAPROXY_PID 2>/dev/null; then
  echo "ERROR: HAProxy failed to start. Check logs:"
  tail -n 20 /var/log/haproxy-startup.log
  exit 1
fi

# Start Data Plane API in the background
echo "Starting Data Plane API..."
dataplaneapi -f /usr/local/etc/haproxy/dataplaneapi.yml > /var/log/dataplaneapi.log 2>&1 &
DATAPLANEAPI_PID=$!
echo "Data Plane API started with PID $DATAPLANEAPI_PID"

# Wait for Data Plane API to initialize
echo "Waiting for Data Plane API to initialize..."
max_attempts=30
attempt=0

while [ $attempt -lt $max_attempts ]; do
  attempt=$((attempt + 1))
  if curl -s -f -o /dev/null http://localhost:5555/v3/health; then
    echo "Data Plane API is running"
    break
  else
    # Check if process is still running
    if ! kill -0 $DATAPLANEAPI_PID 2>/dev/null; then
      echo "ERROR: Data Plane API failed to start. Check logs at /var/log/dataplaneapi.log"
      tail -n 20 /var/log/dataplaneapi.log
      exit 1
    fi
    
    echo "Waiting for Data Plane API to start (attempt $attempt of $max_attempts)..."
    sleep 1
  fi
done

if [ $attempt -ge $max_attempts ]; then
  echo "ERROR: Data Plane API did not start in the allowed time"
  tail -n 20 /var/log/dataplaneapi.log
  exit 1
fi

echo "HAProxy and Data Plane API are running"

# Monitor processes and restart them if they fail
while true; do
  sleep 5
  
  # Check if HAProxy is running
  if ! kill -0 $HAPROXY_PID 2>/dev/null; then
    echo "WARNING: HAProxy is not running. Restarting..."
    haproxy -W -db -f /usr/local/etc/haproxy/haproxy.cfg > /var/log/haproxy-startup.log 2>&1 &
    HAPROXY_PID=$!
    echo "HAProxy restarted with PID $HAPROXY_PID"
  fi
  
  # Check if Data Plane API is running
  if ! kill -0 $DATAPLANEAPI_PID 2>/dev/null; then
    echo "WARNING: Data Plane API is not running. Restarting..."
    dataplaneapi -f /usr/local/etc/haproxy/dataplaneapi.yml > /var/log/dataplaneapi.log 2>&1 &
    DATAPLANEAPI_PID=$!
    echo "Data Plane API restarted with PID $DATAPLANEAPI_PID"
  fi
done