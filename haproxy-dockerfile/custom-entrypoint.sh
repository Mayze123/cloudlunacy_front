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

# Verify SSL certificates 
verify_certificates() {
  CERT_DIR="/etc/ssl/certs"
  KEY_DIR="/etc/ssl/private"
  
  echo "Verifying SSL certificates..."
  
  # Check if certificate directories exist
  if [ ! -d "$CERT_DIR" ] || [ ! -d "$KEY_DIR" ]; then
    echo "Warning: Certificate directories don't exist. Creating them..."
    mkdir -p "$CERT_DIR" "$KEY_DIR"
    return 1
  fi
  
  # Check if we have any certificates
  CERT_COUNT=$(find "$CERT_DIR" -name "*.crt" -o -name "*.pem" | wc -l)
  KEY_COUNT=$(find "$KEY_DIR" -name "*.key" -o -name "*.pem" | wc -l)
  
  if [ "$CERT_COUNT" -eq 0 ] || [ "$KEY_COUNT" -eq 0 ]; then
    echo "Warning: No certificates found."
    return 1
  fi
  
  # Verify each certificate
  for cert in $(find "$CERT_DIR" -name "*.crt" -o -name "*.pem"); do
    echo "Verifying certificate: $cert"
    if ! openssl x509 -in "$cert" -noout -text > /dev/null 2>&1; then
      echo "Error: Invalid certificate: $cert"
    else
      EXPIRY=$(openssl x509 -in "$cert" -noout -enddate | cut -d= -f2)
      echo "Certificate $cert expires on: $EXPIRY"
    fi
  done
  
  echo "Certificate verification completed."
  return 0
}

# Run certificate verification
verify_certificates

# Copy the original haproxy.cfg to a temporary file
cp /usr/local/etc/haproxy/haproxy.cfg /tmp/haproxy.cfg

# Backup the original config
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p /var/lib/haproxy/backups
cp /usr/local/etc/haproxy/haproxy.cfg "/var/lib/haproxy/backups/haproxy_${TIMESTAMP}.cfg"
echo "Configuration backed up to /var/lib/haproxy/backups/haproxy_${TIMESTAMP}.cfg"

# Append Data Plane API configuration if not already present
if ! grep -q "userlist dataplaneapi" /tmp/haproxy.cfg; then
    echo "Adding Data Plane API configuration..."
    cat << EOF >> /tmp/haproxy.cfg

# Data Plane API User List
userlist dataplaneapi
    user admin insecure-password admin

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
    http-request return status 200 content-type "text/plain" string "healthy" if { path /health }
    
    # Forward API requests to Data Plane API backend instead of returning static responses
    default_backend dataplane_api_backend
    
    # Return 401 for unauthenticated requests
    http-request return status 401 content-type "application/json" string "{\"status\":\"Error\",\"message\":\"Authentication required\"}" if { path_beg /v1 } !authenticated
    http-request return status 401 content-type "application/json" string "{\"status\":\"Error\",\"message\":\"Authentication required\"}" if { path_beg /v2 } !authenticated
    http-request return status 401 content-type "application/json" string "{\"status\":\"Error\",\"message\":\"Authentication required\"}" if { path_beg /v3 } !authenticated

# Data Plane API Backend
backend dataplane_api_backend
    mode http
    server dpapi 127.0.0.1:5556 check
EOF
fi

# Update backend health check configuration for better resilience
if grep -q "backend node-app-backend" /tmp/haproxy.cfg; then
    echo "Updating node-app-backend configuration for improved resilience..."
    # Create a temporary file with the updated backend
    cat > /tmp/node-backend-config.txt << EOF
# Backend for Node.js app with improved resilience
backend node-app-backend
    mode http
    option httpchk GET /health
    http-check expect status 200
    default-server inter 5s fall 5 rise 2 slowstart 30s
    timeout connect 5s
    timeout server 30s
    retries 3
    
    # Improved logging for troubleshooting
    option log-health-checks
    
    # Retry on connection failures
    option redispatch
    
    # Add error file for when backend is down
    errorfile 503 /etc/haproxy/errors/503.http
    
    # Add the server with additional options
    server node_app node-app:3005 check maxconn 100 on-marked-down shutdown-sessions weight 100 check inter 3s
    
    # Return a 200 OK status for health check requests when all servers are down
    # This prevents the entire backend from being marked as down
    http-request return status 200 content-type "text/plain" string "Service Maintenance" if { nbsrv(node-app-backend) eq 0 } { path /health }
EOF

    # Replace the existing backend with the new one
    sed -i '/backend node-app-backend/,/server node_app/c\'"$(cat /tmp/node-backend-config.txt)" /tmp/haproxy.cfg
    rm /tmp/node-backend-config.txt
fi

echo "Starting HAProxy with configuration:"
head -n 20 /tmp/haproxy.cfg

# Verify the configuration before starting
echo "Verifying HAProxy configuration..."
if ! haproxy -c -f /tmp/haproxy.cfg; then
    echo "ERROR: HAProxy configuration is invalid! Using fallback configuration..."
    # Create a minimal working configuration
    cat > /tmp/haproxy-minimal.cfg << EOF
global
    log stdout format raw local0 info
    daemon
    maxconn 4000

defaults
    log global
    mode http
    timeout connect 5s
    timeout client 30s
    timeout server 30s

frontend stats
    bind *:8081
    stats enable
    stats uri /stats
    stats refresh 10s

# Data Plane API User List
userlist dataplaneapi
    user admin insecure-password admin

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
    http-request return status 200 content-type "text/plain" string "healthy" if { path /health }
    
    # Forward API requests to Data Plane API backend
    default_backend dataplane_api_backend
    
    # Return 401 for unauthenticated requests
    http-request return status 401 content-type "application/json" string "{\"status\":\"Error\",\"message\":\"Authentication required\"}" if { path_beg /v1 } !authenticated
    http-request return status 401 content-type "application/json" string "{\"status\":\"Error\",\"message\":\"Authentication required\"}" if { path_beg /v2 } !authenticated
    http-request return status 401 content-type "application/json" string "{\"status\":\"Error\",\"message\":\"Authentication required\"}" if { path_beg /v3 } !authenticated

# Data Plane API Backend
backend dataplane_api_backend
    mode http
    server dpapi 127.0.0.1:5556 check

frontend app
    bind *:80
    default_backend app_backend

backend app_backend
    server app node-app:3005 check
    # Return a 200 OK for health checks when server is down
    http-request return status 200 content-type "text/plain" string "Service Maintenance" if { nbsrv(app_backend) eq 0 } { path /health }
EOF
    
    echo "Using minimal fallback configuration."
    cp /tmp/haproxy-minimal.cfg /tmp/haproxy.cfg
fi

# Create a wrapper script to start both processes
cat > /tmp/start-services.sh << 'EOF'
#!/bin/sh

# Start Data Plane API in the background
echo "Starting Data Plane API on port 5556..."
dataplaneapi -f /usr/local/etc/haproxy/dataplaneapi.yml > /var/log/dataplaneapi.log 2>&1 &
DATA_PLANE_PID=$!

# Wait for Data Plane API to initialize
echo "Waiting for Data Plane API to become available..."
MAX_RETRIES=10
RETRY_COUNT=0
API_READY=false

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    sleep 2
    if curl -s -f -u "admin:admin" http://localhost:5556/v2/info > /dev/null 2>&1; then
        echo "Data Plane API is available on port 5556!"
        API_READY=true
        break
    fi
    RETRY_COUNT=$((RETRY_COUNT+1))
    echo "Data Plane API not yet available, retrying ($RETRY_COUNT/$MAX_RETRIES)..."
done

if [ "$API_READY" = false ]; then
    echo "WARNING: Data Plane API did not become available after $MAX_RETRIES attempts."
    echo "Checking DataPlane API logs:"
    tail -n 20 /var/log/dataplaneapi.log
fi

# Start HAProxy in the foreground
echo "Starting HAProxy..."
haproxy -f /tmp/haproxy.cfg -d

# We should never reach this point, but just in case
echo "HAProxy exited. Stopping Data Plane API..."
kill $DATA_PLANE_PID
EOF

# Make the script executable
chmod +x /tmp/start-services.sh

# Run the script to start both services
echo "Starting both HAProxy and Data Plane API..."
exec /tmp/start-services.sh