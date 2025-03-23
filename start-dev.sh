#!/bin/bash
set -e

# Configuration 
APP_DOMAIN=${APP_DOMAIN:-apps.localhost}
MONGO_DOMAIN=${MONGO_DOMAIN:-mongodb.localhost}
NODE_PORT=${NODE_PORT:-3005}

# Create required directories
echo "Creating required directories..."
mkdir -p config/haproxy config/certs logs

# Create initial HAProxy configuration if it doesn't exist
if [ ! -f "config/haproxy/haproxy.cfg" ]; then
  echo "Creating initial HAProxy configuration..."
  cat > config/haproxy/haproxy.cfg <<EOF
global
    log /dev/log local0
    log /dev/log local1 notice
    chroot /var/lib/haproxy
    stats socket /var/run/haproxy.sock mode 660 level admin expose-fd listeners
    stats timeout 30s
    user haproxy
    group haproxy
    daemon

    # TLS settings
    ssl-default-bind-options no-sslv3 no-tlsv10 no-tlsv11 prefer-client-ciphers
    ssl-default-bind-ciphersuites TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256
    ssl-default-bind-ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384
    
    # Set maximum connection limits
    maxconn 4000
    
defaults
    log     global
    mode    http
    option  httplog
    option  dontlognull
    timeout connect 5000
    timeout client  50000
    timeout server  50000
    errorfile 400 /usr/local/etc/haproxy/errors/400.http
    errorfile 403 /usr/local/etc/haproxy/errors/403.http
    errorfile 408 /usr/local/etc/haproxy/errors/408.http
    errorfile 500 /usr/local/etc/haproxy/errors/500.http
    errorfile 502 /usr/local/etc/haproxy/errors/502.http
    errorfile 503 /usr/local/etc/haproxy/errors/503.http
    errorfile 504 /usr/local/etc/haproxy/errors/504.http

# Frontend for HTTP traffic - redirects to HTTPS
frontend http-in
    bind *:80
    mode http
    option forwardfor
    
    # Redirect HTTP to HTTPS
    redirect scheme https code 301 if !{ ssl_fc }

# Frontend for HTTPS traffic
frontend https-in
    bind *:443 ssl crt /etc/ssl/certs/localhost.pem alpn h2,http/1.1
    mode http
    option forwardfor
    
    # Default backend for node application
    default_backend node-app-backend
    
    # Stats page
    acl stats-acl path_beg /stats
    use_backend stats-backend if stats-acl

# Frontend for MongoDB traffic
frontend mongodb-in
    bind *:27017 ssl crt /etc/ssl/certs/mongodb.pem
    mode tcp
    option tcplog
    
    # Extract the agent ID from the SNI hostname
    http-request set-var(txn.agent_id) req.ssl_sni,field(1,'.')
    
    # Use mongodb-backend-dyn for MongoDB connections
    default_backend mongodb-backend-dyn

# Backend for Node.js app
backend node-app-backend
    mode http
    option httpchk GET /health
    http-check expect status 200
    server node-app cloudlunacy-front-dev:3005 check

# Backend for MongoDB
backend mongodb-backend-dyn
    mode tcp
    option tcp-check
    # Servers will be added dynamically by the application

# Backend for stats page
backend stats-backend
    mode http
    stats enable
    stats uri /stats
    stats refresh 10s
    stats show-legends
    stats auth admin:admin_password
EOF
fi

# Generate self-signed certificates if they don't exist
if [ ! -f "config/certs/localhost.pem" ]; then
  echo "Generating self-signed certificates for localhost..."
  mkdir -p config/certs
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout config/certs/localhost.key \
    -out config/certs/localhost.crt \
    -subj "/CN=localhost/O=CloudLunacy Dev/C=US"
    
  cat config/certs/localhost.crt config/certs/localhost.key > config/certs/localhost.pem
fi

if [ ! -f "config/certs/mongodb.pem" ]; then
  echo "Generating self-signed certificates for MongoDB..."
  mkdir -p config/certs
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout config/certs/mongodb.key \
    -out config/certs/mongodb.crt \
    -subj "/CN=*.${MONGO_DOMAIN}/O=CloudLunacy Dev/C=US"
    
  cat config/certs/mongodb.crt config/certs/mongodb.key > config/certs/mongodb.pem
  
  # Generate CA certificate
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout config/certs/ca.key \
    -out config/certs/ca.crt \
    -subj "/CN=Cloudlunacy CA/O=CloudLunacy Dev/C=US"
fi

# Create Docker networks if they don't exist
if ! docker network ls | grep -q "haproxy-network"; then
  echo "Creating haproxy-network..."
  docker network create haproxy-network
fi

if ! docker network ls | grep -q "cloudlunacy-network"; then
  echo "Creating cloudlunacy-network..."
  docker network create cloudlunacy-network
fi

# Stop existing containers to allow for clean restart
echo "Stopping existing containers if running..."
docker rm -f haproxy-dev cloudlunacy-front-dev 2>/dev/null || true

# Start the stack with docker-compose
echo "Starting the CloudLunacy stack in development mode..."
docker-compose -f docker-compose.dev.yml up -d

# Wait a moment for services to initialize
sleep 3

# Show status
echo "CloudLunacy development stack is starting..."
echo " - HAProxy: http://localhost:8081/stats (admin/admin_password)"
echo " - Node app: http://localhost:3005/health"
echo " - MongoDB access: ${MONGO_DOMAIN}:27017"
echo ""
echo "Add to your hosts file:"
echo "127.0.0.1 ${APP_DOMAIN}"
echo "127.0.0.1 ${MONGO_DOMAIN}"
echo "127.0.0.1 api.${APP_DOMAIN}"
echo ""
echo "To view logs:"
echo "docker logs -f cloudlunacy-front-dev"
echo "docker logs -f haproxy-dev" 