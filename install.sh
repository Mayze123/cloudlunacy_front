#!/bin/bash
# ------------------------------------------------------------------------------
# CloudLunacy Front Server Installation Script
# Version: 2.0.0
# Date: 2025-03-10
#
# This script installs the CloudLunacy Front Server with robust error handling,
# state validation at each step, and automatic recovery options.
# ------------------------------------------------------------------------------

set -euo pipefail
IFS=$'\n\t'

# Color codes for output formatting
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration variables - defaults that can be overridden by environment variables
: "${FRONT_REPO_URL:=https://github.com/Mayze123/cloudlunacy_front}" 
: "${DOMAIN:=cloudlunacy.local}" 
: "${MONGO_DOMAIN:=mongodb.cloudlunacy.uk}"
: "${APP_DOMAIN:=apps.cloudlunacy.uk}"
: "${NODE_PORT:=3005}"
: "${JWT_SECRET:=}"
: "${SHARED_NETWORK:=cloudlunacy-network}"

# Generate JWT secret if none provided
if [ -z "$JWT_SECRET" ]; then
  JWT_SECRET=$(openssl rand -base64 32)
fi

# Base directories
BASE_DIR="/opt/cloudlunacy_front"
CONFIG_DIR="${BASE_DIR}/config"
AGENTS_CONFIG_DIR="${CONFIG_DIR}/agents"
CERTS_DIR="${BASE_DIR}/traefik-certs"
LOGS_DIR="/var/log/traefik"
TRAEFIK_NETWORK="traefik-network"

# Installation state tracking
INSTALL_LOG="/tmp/cloudlunacy_install.log"
INSTALL_STATE="/tmp/cloudlunacy_install_state.json"

# Function definitions

# Logging functions
log() { 
  echo -e "${GREEN}[INFO]${NC} $1" | tee -a "$INSTALL_LOG"
}

warn() {
  echo -e "${YELLOW}[WARN]${NC} $1" | tee -a "$INSTALL_LOG"
}

error() {
  echo -e "${RED}[ERROR]${NC} $1" | tee -a "$INSTALL_LOG"
}

success() {
  echo -e "${BLUE}[SUCCESS]${NC} $1" | tee -a "$INSTALL_LOG"
}

# Error exit with cleanup option
error_exit() {
  error "$1"
  
  # Ask if user wants to attempt cleanup
  if [ "${2:-}" != "no_prompt" ]; then
    read -p "Do you want to attempt cleanup of incomplete installation? (y/N): " choice
    case "$choice" in
      y|Y) cleanup_installation ;;
      *) echo "Exiting without cleanup." ;;
    esac
  fi
  
  exit 1
}

# Installation state management
init_install_state() {
  cat > "$INSTALL_STATE" <<EOF
{
  "prerequisites_checked": false,
  "directory_created": false,
  "repository_cloned": false,
  "config_files_created": false,
  "networks_created": false,
  "containers_started": false,
  "installation_completed": false
}
EOF
  log "Installation state initialized"
}

update_install_state() {
  local key="$1"
  local value="$2"
  
  # Use temporary file for atomic update
  local temp_file="${INSTALL_STATE}.tmp"
  
  # Update the value
  jq ".$key = $value" "$INSTALL_STATE" > "$temp_file"
  mv "$temp_file" "$INSTALL_STATE"
  
  log "Installation state updated: $key = $value"
}

get_install_state() {
  local key="$1"
  jq -r ".$key" "$INSTALL_STATE"
}

# Check for required tools
check_prerequisites() {
  log "Checking prerequisites..."
  
  # Check for required commands
  for cmd in docker docker-compose curl jq openssl git; do
    if ! command -v "$cmd" &> /dev/null; then
      error "Required command not found: $cmd"
      error "Please install $cmd and try again"
      return 1
    fi
  done
  
  # Check Docker daemon is running
  if ! docker info &> /dev/null; then
    error "Docker daemon is not running"
    error "Please start Docker service with: sudo systemctl start docker"
    return 1
  fi
  
  # Check user has permissions to use Docker
  if ! docker ps &> /dev/null; then
    error "Current user doesn't have permission to use Docker"
    error "Please add user to docker group with: sudo usermod -aG docker $USER"
    error "Then log out and back in for changes to take effect"
    return 1
  }
  
  # Check disk space
  local available_space=$(df -m / | awk 'NR==2 {print $4}')
  if [ "$available_space" -lt 1000 ]; then
    warn "Low disk space: ${available_space}MB available, recommended at least 1GB"
    warn "Installation may fail or perform poorly due to limited disk space"
    return 1
  fi
  
  log "All prerequisites satisfied"
  update_install_state "prerequisites_checked" "true"
  return 0
}

# Create directories
create_directories() {
  log "Creating directories..."
  
  # Check if BASE_DIR already exists
  if [ -d "$BASE_DIR" ]; then
    warn "Directory $BASE_DIR already exists"
    read -p "Do you want to remove it and continue? (y/N): " choice
    case "$choice" in
      y|Y) 
        log "Removing existing directory: $BASE_DIR"
        rm -rf "$BASE_DIR" || error_exit "Failed to remove directory $BASE_DIR"
        ;;
      *) 
        error_exit "Installation aborted by user"
        ;;
    esac
  fi
  
  # Create directories with proper permissions
  mkdir -p "$BASE_DIR" "$CONFIG_DIR" "$AGENTS_CONFIG_DIR" "$CERTS_DIR" "$LOGS_DIR" || error_exit "Failed to create directories"
  chmod 755 "$BASE_DIR" "$CONFIG_DIR" "$AGENTS_CONFIG_DIR" "$LOGS_DIR"
  chmod 700 "$CERTS_DIR"  # More restrictive for certs
  
  log "Directories created successfully"
  update_install_state "directory_created" "true"
  return 0
}

# Clone repository
clone_repository() {
  log "Cloning front server repository from $FRONT_REPO_URL..."
  
  git clone "$FRONT_REPO_URL" "$BASE_DIR" || error_exit "Failed to clone repository"
  
  log "Repository cloned successfully"
  update_install_state "repository_cloned" "true"
  return 0
}

# Create configuration files
create_config_files() {
  log "Creating configuration files..."
  
  # Create .env file
  cat > "${BASE_DIR}/.env" <<EOF
# CloudLunacy Front Server Environment Configuration
# Generated on $(date)
DOMAIN=${DOMAIN}
MONGO_DOMAIN=${MONGO_DOMAIN}
APP_DOMAIN=${APP_DOMAIN}
NODE_PORT=${NODE_PORT}
JWT_SECRET=${JWT_SECRET}
SHARED_NETWORK=${SHARED_NETWORK}
CONFIG_BASE_PATH=${CONFIG_DIR}
LOG_LEVEL=info
EOF

  # Create Traefik configuration
  cat > "${CONFIG_DIR}/traefik.yml" <<'EOF'
# Global settings
global:
  checkNewVersion: false
  sendAnonymousUsage: false

# Entry points definition
entryPoints:
  web:
    address: ":80"
    http:
      redirections:
        entryPoint:
          to: websecure
          scheme: https
  websecure:
    address: ":443"
  dashboard:
    address: ":8081"
  mongodb:
    address: ":27017"  # MongoDB entrypoint explicitly defined

# API and dashboard configuration
api:
  dashboard: true
  insecure: true

# Enable ping for health checks
ping:
  entryPoint: "dashboard"

# Log configuration
log:
  level: "INFO"
  filePath: "/var/log/traefik/traefik.log"
  format: "json"

# Access logs
accessLog:
  filePath: "/var/log/traefik/access.log"
  format: "json"

# Configure providers
providers:
  # Main dynamic configuration file
  file:
    filename: "/etc/traefik/dynamic.yml"
    watch: true
  
  # Per-agent configuration directory
  directory:
    directory: "/etc/traefik/agents"
    watch: true
  
  # Docker provider for container discovery
  docker:
    endpoint: "unix:///var/run/docker.sock"
    exposedByDefault: false
    watch: true
    network: "${SHARED_NETWORK}"

# Certificate resolver for HTTPS
certificatesResolvers:
  letsencrypt:
    acme:
      email: "admin@example.com"  # Replace with your email
      storage: "/traefik-certs/acme.json"
      httpChallenge:
        entryPoint: "web"
EOF

  # Create dynamic configuration
  cat > "${CONFIG_DIR}/dynamic.yml" <<'EOF'
# Dynamic configuration for Traefik
http:
  routers:
    # Dashboard router with basic auth
    dashboard:
      rule: "Host(`traefik.localhost`) && (PathPrefix(`/api`) || PathPrefix(`/dashboard`))"
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
          - "admin:$apr1$H6uskkkW$IgXLP6ewTrSuBkTrqE8wj/"  # Default admin/admin - CHANGE THIS IN PRODUCTION
    
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
      rule: "HostSNI(`*.mongodb.cloudlunacy.uk`)"
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

  # Create a sample agent configuration file
  cat > "${AGENTS_CONFIG_DIR}/default.yml" <<'EOF'
# Default agent configuration
http:
  routers: {}
  services: {}
  middlewares: {}
tcp:
  routers: {}
  services: {}
EOF

  # Create empty acme.json file with proper permissions
  touch "${CERTS_DIR}/acme.json"
  chmod 600 "${CERTS_DIR}/acme.json"

  # Create docker-compose.yml with network configuration
  cat > "${BASE_DIR}/docker-compose.yml" <<EOF
version: '3.8'

services:
  traefik:
    image: traefik:v2.10
    container_name: traefik
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "8081:8081"
      - "27017:27017"  # MongoDB port explicitly exposed
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./config:/etc/traefik
      - ./config/agents:/etc/traefik/agents
      - ./traefik-certs:/traefik-certs
      - /var/log/traefik:/var/log/traefik
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:8080/ping"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 10s
    networks:
      - traefik-network
      - ${SHARED_NETWORK}

  node-app:
    build:
      context: ./node-app
      dockerfile: Dockerfile
    container_name: node-app
    restart: unless-stopped
    env_file:
      - ./.env
    ports:
      - "${NODE_PORT}:3005"
    volumes:
      - ./config:/app/config
    networks:
      - traefik-network
      - ${SHARED_NETWORK}
    depends_on:
      - traefik
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3005/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.node-app.rule=Host(\`front.${DOMAIN}\`)"
      - "traefik.http.routers.node-app.entrypoints=web,websecure"
      - "traefik.http.routers.node-app.tls.certresolver=letsencrypt"
      - "traefik.http.services.node-app.loadbalancer.server.port=3005"

networks:
  traefik-network:
    name: traefik-network
  ${SHARED_NETWORK}:
    external: true
EOF

  log "Configuration files created successfully"
  update_install_state "config_files_created" "true"
  return 0
}

# Create Docker networks
create_networks() {
  log "Creating Docker networks..."
  
  # Create Traefik network if it doesn't exist
  if ! docker network ls | grep -q "${TRAEFIK_NETWORK}"; then
    log "Creating ${TRAEFIK_NETWORK} network..."
    docker network create "${TRAEFIK_NETWORK}" || error_exit "Failed to create ${TRAEFIK_NETWORK} network"
  else
    log "${TRAEFIK_NETWORK} network already exists"
  fi

  # Create or verify shared network
  if ! docker network ls | grep -q "${SHARED_NETWORK}"; then
    log "Creating ${SHARED_NETWORK} network..."
    docker network create "${SHARED_NETWORK}" || error_exit "Failed to create ${SHARED_NETWORK} network"
  else
    log "${SHARED_NETWORK} network already exists"
  fi
  
  log "Docker networks created/verified successfully"
  update_install_state "networks_created" "true"
  return 0
}

# Start containers
start_containers() {
  log "Starting Docker containers..."
  
  cd "${BASE_DIR}" || error_exit "Failed to change directory to ${BASE_DIR}"
  
  # Build and start the containers
  docker-compose up -d --build || error_exit "Failed to start Docker containers"
  
  # Wait for services to start
  log "Waiting for services to start..."
  sleep 10
  
  # Check container status
  if ! docker ps | grep -q "traefik"; then
    error "Traefik container is not running"
    docker logs traefik
    error_exit "Failed to start Traefik container"
  fi
  
  if ! docker ps | grep -q "node-app"; then
    error "Node.js app container is not running"
    docker logs node-app
    error_exit "Failed to start Node.js app container"
  fi
  
  log "Containers started successfully"
  update_install_state "containers_started" "true"
  return 0
}

# Verify services
verify_services() {
  log "Verifying services..."
  
  # Check Traefik health
  local traefik_health
  traefik_health=$(docker inspect --format='{{.State.Health.Status}}' traefik 2>/dev/null || echo "unknown")
  
  if [ "$traefik_health" = "healthy" ]; then
    success "Traefik is healthy"
  else
    log "Checking Traefik status..." 
    if curl -s http://localhost:8080/ping > /dev/null; then
      success "Traefik is responding to ping"
    else
      warn "Traefik health check failed, service may not be fully operational yet"
      docker logs traefik | tail -n 20
    fi
  fi
  
  # Check node-app health
  local node_health
  node_health=$(docker inspect --format='{{.State.Health.Status}}' node-app 2>/dev/null || echo "unknown")
  
  if [ "$node_health" = "healthy" ]; then
    success "Node.js app is healthy"
  else
    log "Checking Node.js app status..."
    if curl -s http://localhost:${NODE_PORT}/health > /dev/null; then
      success "Node.js app is responding to health check"
    else
      warn "Node.js app health check failed, service may not be fully operational yet"
      docker logs node-app | tail -n 20
    fi
  fi
  
  # Verify MongoDB port exposure
  if docker port traefik | grep -q 27017; then
    success "MongoDB port 27017 is properly exposed in Traefik"
  else
    warn "MongoDB port 27017 is not properly exposed in Traefik"
    warn "MongoDB forwarding may not work correctly"
  fi
  
  log "Service verification completed"
  update_install_state "installation_completed" "true"
  return 0
}

# Cleanup installation if something fails
cleanup_installation() {
  log "Cleaning up installation..."
  
  # Stop containers if they were started
  if [ "$(get_install_state "containers_started")" = "true" ]; then
    log "Stopping containers..."
    cd "${BASE_DIR}" && docker-compose down || warn "Failed to stop containers"
  fi
  
  # Remove networks if they were created by this script
  if [ "$(get_install_state "networks_created")" = "true" ]; then
    log "Removing Docker networks..."
    docker network rm "${TRAEFIK_NETWORK}" 2>/dev/null || true
    # Don't remove shared network as it might be used by other services
  fi
  
  # Remove directories if they were created
  if [ "$(get_install_state "directory_created")" = "true" ]; then
    log "Removing directories..."
    rm -rf "${BASE_DIR}" || warn "Failed to remove ${BASE_DIR}"
  fi
  
  log "Cleanup completed"
  return 0
}

# Installation completed message
display_completion_message() {
  success "==========================================="
  success "CloudLunacy Front Server Installation Complete!"
  success "==========================================="
  success ""
  success "Front server is now running at:"
  success "- Traefik dashboard: http://localhost:8081/dashboard/"
  success "- Node.js API: http://localhost:${NODE_PORT}"
  success ""
  success "MongoDB routing is configured for subdomain pattern:"
  success "- <agent-id>.${MONGO_DOMAIN}"
  success ""
  success "App routing is configured for subdomain pattern:"
  success "- <subdomain>.${APP_DOMAIN}"
  success ""
  success "To check logs:"
  success "- Traefik: docker logs traefik"
  success "- Node.js app: docker logs node-app"
  success ""
  success "JWT Secret for agent authentication:"
  success "${JWT_SECRET}"
  success ""
  success "IMPORTANT: Save this JWT secret securely!"
  success "==========================================="
}

# Main installation function
install_front_server() {
  log "Starting CloudLunacy Front Server installation..."
  
  # Initialize installation state
  init_install_state
  
  # Run installation steps
  check_prerequisites || error_exit "Prerequisites check failed"
  create_directories || error_exit "Directory creation failed"
  clone_repository || error_exit "Repository cloning failed"
  create_config_files || error_exit "Configuration file creation failed"
  create_networks || error_exit "Network creation failed"
  start_containers || error_exit "Container startup failed"
  verify_services || warn "Service verification produced warnings"
  
  # Display completion message
  display_completion_message
  
  return 0
}

# Run the installation
install_front_server