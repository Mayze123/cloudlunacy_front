#!/bin/sh
set -e

echo "Starting HAProxy with custom configuration..."

# Ensure API transaction directory exists with proper permissions
mkdir -p /etc/haproxy/dataplaneapi
chmod 777 /etc/haproxy/dataplaneapi

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

frontend app
    bind *:80
    default_backend app_backend

backend app_backend
    server app node-app:3005 check
EOF
    
    echo "Using minimal fallback configuration."
    cp /tmp/haproxy-minimal.cfg /tmp/haproxy.cfg
fi

# Start Data Plane API in the background
echo "Starting Data Plane API..."
dataplaneapi -f /usr/local/etc/haproxy/dataplaneapi.yml &

# Wait a moment for the Data Plane API to initialize
sleep 2

# Run the original HAProxy entrypoint with our config
exec docker-entrypoint.sh haproxy -f /tmp/haproxy.cfg "$@" 