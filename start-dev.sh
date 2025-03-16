#!/bin/bash
# Development startup script

# Set up environment
export NODE_ENV=development
export MONGO_DOMAIN=mongodb.localhost
export APP_DOMAIN=apps.localhost

# Create necessary directories
mkdir -p config/agents logs traefik-certs

# Create initial dynamic.yml if it doesn't exist
if [ ! -f "config/dynamic.yml" ]; then
  cat > config/dynamic.yml <<EOF
# Dynamic configuration for Traefik
http:
  routers:
    dashboard:
      rule: "Host(\`traefik.localhost\`) && (PathPrefix(\`/api\`) || PathPrefix(\`/dashboard\`))"
      service: "api@internal"
      entryPoints:
        - "dashboard"
      middlewares:
        - "auth"

  middlewares:
    auth:
      basicAuth:
        users:
          - "admin:\$apr1\$H6uskkkW\$IgXLP6ewTrSuBkTrqE8wj/"  # Default admin/admin
    
    web-to-websecure:
      redirectScheme:
        scheme: https
        permanent: true

  services: {}

tcp:
  routers:
    mongodb-catchall:
      rule: "HostSNI(\`*.mongodb.localhost\`)"
      entryPoints:
        - "mongodb"
      service: "mongodb-catchall-service"
      tls:
        passthrough: true
  services:
    mongodb-catchall-service:
      loadBalancer:
        servers: []
EOF
fi

# Create traefik.yml if it doesn't exist
if [ ! -f "config/traefik.yml" ]; then
  cat > config/traefik.yml <<EOF
# Global settings
global:
  checkNewVersion: false
  sendAnonymousUsage: false

# TLS options
tls:
  options:
    default:
      minVersion: "VersionTLS12"
      sniStrict: true

# Entry points definition
entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"
  dashboard:
    address: ":8081"
  mongodb:
    address: ":27017"
    transport:
      respondingTimeouts:
        idleTimeout: "1h"

# API and dashboard configuration
api:
  dashboard: true
  insecure: true
  debug: true

# Ping for healthcheck
ping:
  entryPoint: "dashboard"

# Log configuration
log:
  level: "DEBUG"
  filePath: "/var/log/traefik/traefik.log"
  format: "json"

# Access logs
accessLog:
  filePath: "/var/log/traefik/access.log"
  format: "json"
  bufferingSize: 100

# Configure providers
providers:
  # Main dynamic configuration file
  file:
    filename: "/etc/traefik/dynamic.yml"
    watch: true

  # Docker provider for container discovery
  docker:
    endpoint: "unix:///var/run/docker.sock"
    exposedByDefault: false
    watch: true
    network: "traefik-network"
    swarmMode: false
EOF
fi

# Create Docker networks if they don't exist
if ! docker network ls | grep -q "traefik-network"; then
  echo "Creating traefik-network..."
  docker network create traefik-network
else
  echo "traefik-network already exists"
fi

if ! docker network ls | grep -q "cloudlunacy-network"; then
  echo "Creating cloudlunacy-network..."
  docker network create cloudlunacy-network
else
  echo "cloudlunacy-network already exists"
fi

# Remove any existing containers with the same names to avoid conflicts
echo "Removing any existing containers with the same names..."
docker rm -f traefik-dev cloudlunacy-front-dev mongodb-test 2>/dev/null || true

# Start the development environment
echo "Starting development environment..."
docker-compose -f docker-compose.dev.yml up --build "$@" 