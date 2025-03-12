#!/bin/bash
# auto-recovery.sh
#
# This script provides auto-recovery for the CloudLunacy front server
# It should be set up as a cron job to run every 5 minutes
#
# Usage: ./auto-recovery.sh
#
# Recommended cron: */5 * * * * /opt/cloudlunacy_front/scripts/auto-recovery.sh >> /var/log/cloudlunacy-recovery.log 2>&1

set -e

# Configuration
BASE_DIR="/opt/cloudlunacy_front"
LOG_FILE="/var/log/cloudlunacy-recovery.log"
MAX_RESTARTS=3
NODE_PORT=${NODE_PORT:-3005}
SHARED_NETWORK=${SHARED_NETWORK:-cloudlunacy-network}

# Create log directory if it doesn't exist
mkdir -p "$(dirname "$LOG_FILE")"

# Timestamp function
timestamp() {
  date "+%Y-%m-%d %H:%M:%S"
}

# Logging functions
log_info() {
  echo "$(timestamp) [INFO] $1"
}

log_warn() {
  echo "$(timestamp) [WARN] $1"
}

log_error() {
  echo "$(timestamp) [ERROR] $1"
}

# Check if services are running properly
check_services() {
  log_info "Checking services status..."
  
  # Check Traefik status
  if ! docker ps | grep -q traefik; then
    log_warn "Traefik container is not running"
    return 1
  fi
  
  # Check traefik health
  TRAEFIK_HEALTH=$(docker inspect --format='{{.State.Health.Status}}' traefik 2>/dev/null || echo "unknown")
  if [ "$TRAEFIK_HEALTH" != "healthy" ]; then
    log_warn "Traefik container is not healthy (status: $TRAEFIK_HEALTH)"
    return 1
  fi
  
  # Check node-app status
  if ! docker ps | grep -q node-app; then
    log_warn "node-app container is not running"
    return 1
  fi
  
  # Check node-app health
  NODE_HEALTH=$(docker inspect --format='{{.State.Health.Status}}' node-app 2>/dev/null || echo "unknown")
  if [ "$NODE_HEALTH" != "healthy" ]; then
    log_warn "node-app container is not healthy (status: $NODE_HEALTH)"
    return 1
  }
  
  # Check MongoDB port is exposed in Traefik
  if ! docker port traefik | grep -q "27017"; then
    log_warn "MongoDB port 27017 is not exposed in Traefik"
    return 1
  fi
  
  # Check if the API is responding
  if ! curl -s "http://localhost:${NODE_PORT}/health" > /dev/null; then
    log_warn "API is not responding on port ${NODE_PORT}"
    return 1
  fi
  
  log_info "All services are running correctly"
  return 0
}

# Restart services
restart_services() {
  log_info "Restarting services..."
  
  # Navigate to the base directory
  cd "${BASE_DIR}" || return 1
  
  # Start with a soft restart of containers
  docker-compose restart traefik node-app
  
  # Wait for services to start
  sleep 10
  
  # Check if services are running
  if check_services; then
    log_info "Services restarted successfully"
    return 0
  else
    log_warn "Soft restart failed, trying full restart"
    
    # Try full restart
    docker-compose down
    docker-compose up -d
    
    # Wait for services to start
    sleep 30
    
    if check_services; then
      log_info "Full restart succeeded"
      return 0
    else
      log_error "Full restart failed"
      return 1
    fi
  }
}

# Check networks
check_networks() {
  log_info "Checking Docker networks..."
  
  # Check traefik-network
  if ! docker network ls | grep -q "traefik-network"; then
    log_warn "traefik-network is missing, creating it"
    docker network create traefik-network
  fi
  
  # Check shared network
  if ! docker network ls | grep -q "${SHARED_NETWORK}"; then
    log_warn "${SHARED_NETWORK} is missing, creating it"
    docker network create "${SHARED_NETWORK}"
  fi
  
  # Ensure containers are connected to networks
  for CONTAINER in traefik node-app; do
    if docker ps -q --filter "name=${CONTAINER}" | grep -q .; then
      # Check if container is connected to traefik-network
      if ! docker inspect "${CONTAINER}" | grep -q "traefik-network"; then
        log_warn "${CONTAINER} is not connected to traefik-network, connecting it"
        docker network connect traefik-network "${CONTAINER}"
      fi
      
      # Check if container is connected to shared network
      if ! docker inspect "${CONTAINER}" | grep -q "${SHARED_NETWORK}"; then
        log_warn "${CONTAINER} is not connected to ${SHARED_NETWORK}, connecting it"
        docker network connect "${SHARED_NETWORK}" "${CONTAINER}"
      fi
    fi
  done
  
  log_info "Network verification completed"
}

# Check MongoDB port exposure
check_mongodb_port() {
  log_info "Checking MongoDB port exposure..."
  
  # Check if port 27017 is exposed in Traefik
  if ! docker port traefik | grep -q "27017"; then
    log_warn "MongoDB port 27017 is not exposed in Traefik"
    
    # Check docker-compose.yml for the port
    if ! grep -q "27017:27017" "${BASE_DIR}/docker-compose.yml"; then
      log_warn "MongoDB port is not defined in docker-compose.yml, adding it"
      
      # Create backup of docker-compose.yml
      cp "${BASE_DIR}/docker-compose.yml" "${BASE_DIR}/docker-compose.yml.bak.$(date +%Y%m%d%H%M%S)"
      
      # Add the port to the file
      sed -i 's/ports:/ports:\n      - "27017:27017"/' "${BASE_DIR}/docker-compose.yml"
      
      # Restart services to apply changes
      log_info "Restarting services to apply port changes"
      restart_services
    else
      log_warn "Port is defined in docker-compose.yml but not exposed, restarting Traefik"
      docker restart traefik
      sleep 10
    fi
  fi
  
  # Verify again
  if docker port traefik | grep -q "27017"; then
    log_info "MongoDB port 27017 is now correctly exposed"
    return 0
  else
    log_error "Failed to expose MongoDB port 27017"
    return 1
  fi
}

# Verify config directory structure
check_config_dirs() {
  log_info "Checking configuration directories..."
  
  # Check base config directory
  if [ ! -d "${BASE_DIR}/config" ]; then
    log_warn "Config directory does not exist, creating it"
    mkdir -p "${BASE_DIR}/config"
  fi
  
  # Check agents directory
  if [ ! -d "${BASE_DIR}/config/agents" ]; then
    log_warn "Agents directory does not exist, creating it"
    mkdir -p "${BASE_DIR}/config/agents"
  fi
  
  # Check for default agent config
  if [ ! -f "${BASE_DIR}/config/agents/default.yml" ]; then
    log_warn "Default agent config does not exist, creating it"
    cat > "${BASE_DIR}/config/agents/default.yml" << EOL
# Default agent configuration
http:
  routers: {}
  services: {}
  middlewares: {}
tcp:
  routers: {}
  services: {}
EOL
  fi
  
  # Check for dynamic.yml
  if [ ! -f "${BASE_DIR}/config/dynamic.yml" ]; then
    log_warn "Dynamic config does not exist, creating it"
    cat > "${BASE_DIR}/config/dynamic.yml" << EOL
# Dynamic configuration for Traefik
http:
  routers:
    # Dashboard router with basic auth
    dashboard:
      rule: "Host(\`traefik.localhost\`) && (PathPrefix(\`/api\`) || PathPrefix(\`/dashboard\`))"
      service: "api@internal"
      entryPoints:
        - "dashboard"
      middlewares:
        - "auth"

  middlewares:
    # Dashboard authentication middleware
    auth:
      basicAuth:
        users:
          - "admin:$apr1$H6uskkkW$IgXLP6ewTrSuBkTrqE8wj/"
    
    # Global redirection middleware - web to websecure
    web-to-websecure:
      redirectScheme:
        scheme: https
        permanent: true

  services: {}

# TCP configuration for MongoDB routing
tcp:
  routers:
    mongodb-catchall:
      rule: "HostSNI(\`*.mongodb.cloudlunacy.uk\`)"
      entryPoints:
        - "mongodb"
      service: "mongodb-catchall-service"
      tls:
        passthrough: true
  services:
    mongodb-catchall-service:
      loadBalancer:
        servers: []
EOL
  fi
  
  # Fix permissions
  chmod -R 755 "${BASE_DIR}/config"
  
  log_info "Configuration directories verified"
}

# Main function
main() {
  log_info "Starting auto-recovery check"
  
  # First check services
  if check_services; then
    log_info "All services are running correctly"
    return 0
  fi
  
  # Check and fix networks
  check_networks
  
  # Check and fix config directories
  check_config_dirs
  
  # Check MongoDB port exposure
  check_mongodb_port
  
  # Now try to restart services
  if restart_services; then
    log_info "Recovery successful"
    return 0
  else
    log_error "Recovery failed after multiple attempts"
    return 1
  fi
}

# Run the main function
main