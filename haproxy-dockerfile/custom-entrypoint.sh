#!/bin/sh
set -e

echo "Starting HAProxy with custom configuration..."

# Ensure API transaction directory exists with proper permissions
mkdir -p /etc/haproxy/dataplaneapi
chmod 777 /etc/haproxy/dataplaneapi

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

# Verify the configuration before starting
echo "Verifying HAProxy configuration..."
if ! haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg; then
  echo "ERROR: HAProxy configuration is invalid! Exiting..."
  exit 1
fi

# Create a simple launcher script to start both services
cat > /usr/local/bin/start-services.sh << 'EOF'
#!/bin/sh

# Set up signal handling for graceful shutdown
trap 'echo "Shutting down services..."; kill -TERM $DATAPLANEAPI_PID $HAPROXY_PID 2>/dev/null; exit 0' TERM INT

# Start Data Plane API in the background
echo "Starting Data Plane API..."
dataplaneapi -f /usr/local/etc/haproxy/dataplaneapi.yml > /var/log/dataplaneapi.log 2>&1 &
DATAPLANEAPI_PID=$!
echo "Data Plane API started with PID $DATAPLANEAPI_PID"

# Give API time to initialize
sleep 2

# Start HAProxy in the background
echo "Starting HAProxy..."
haproxy -f /usr/local/etc/haproxy/haproxy.cfg -d &
HAPROXY_PID=$!
echo "HAProxy started with PID $HAPROXY_PID"

# Monitor both processes and restart them if they fail
while true; do
  sleep 5
  
  # Check if Data Plane API is running
  if ! kill -0 $DATAPLANEAPI_PID 2>/dev/null; then
    echo "Data Plane API died, restarting..."
    dataplaneapi -f /usr/local/etc/haproxy/dataplaneapi.yml > /var/log/dataplaneapi.log 2>&1 &
    DATAPLANEAPI_PID=$!
    echo "Data Plane API restarted with PID $DATAPLANEAPI_PID"
  fi
  
  # Check if HAProxy is running
  if ! kill -0 $HAPROXY_PID 2>/dev/null; then
    echo "HAProxy died, restarting..."
    haproxy -f /usr/local/etc/haproxy/haproxy.cfg -d &
    HAPROXY_PID=$!
    echo "HAProxy restarted with PID $HAPROXY_PID"
  fi
done
EOF

# Make the script executable
chmod +x /usr/local/bin/start-services.sh

# Run the services
echo "Starting services with improved monitoring..."
exec /usr/local/bin/start-services.sh