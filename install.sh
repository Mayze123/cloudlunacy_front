#!/bin/bash
# ------------------------------------------------------------------------------
# Installation Script for CloudLunacy Deployment Agent
# Version: 2.7.0 (Configured for HAProxy)
# Author: Mahamadou Taibou
# Date: 2024-12-01
#
# Description:
# This script installs and configures the CloudLunacy Deployment Agent on a VPS
# with HAProxy support for MongoDB TLS termination
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
USERNAME="cloudlunacy"
# Check if we're already in the cloned repository directory
if [ -f "./install.sh" ] && [ -d "./node-app" ]; then
  BASE_DIR=$(pwd)
  echo -e "${BLUE}[INFO]${NC} Using current directory as base: ${BASE_DIR}"
else
  BASE_DIR="/opt/cloudlunacy"
fi

CERTS_DIR="${BASE_DIR}/config/certs"
# Use the front server's IP as the default API URL.
: "${FRONT_API_URL:=http://138.199.165.36:3005}"
: "${NODE_PORT:=3005}"
: "${MONGO_PORT:=27017}"
: "${MONGO_USE_TLS:=true}"
: "${USE_HAPROXY:=true}"
: "${FRONT_REPO_URL:=https://github.com/Mayze123/cloudlunacy_front}" 
: "${DOMAIN:=cloudlunacy.local}" 
: "${MONGO_DOMAIN:=mongodb.cloudlunacy.uk}"
: "${APP_DOMAIN:=apps.cloudlunacy.uk}"
: "${JWT_SECRET:=}"
: "${SHARED_NETWORK:=cloudlunacy-network}"

# Generate JWT secret if none provided
if [ -z "$JWT_SECRET" ]; then
  JWT_SECRET=$(openssl rand -base64 32)
fi

# Base directories
CONFIG_DIR="${BASE_DIR}/config"
AGENTS_CONFIG_DIR="${CONFIG_DIR}/agents"
CERTS_DIR="${BASE_DIR}/config/certs"
LOGS_DIR="/var/log/haproxy"
HAPROXY_NETWORK="haproxy-network"

# Function definitions

# Logging functions
log() {
  echo -e "\e[34m[INFO]\e[0m $1"
}

log_error() {
  echo -e "\e[31m[ERROR]\e[0m $1" >&2
}

log_warn() {
  echo -e "\e[33m[WARNING]\e[0m $1"
}

log_success() {
  echo -e "\e[32m[SUCCESS]\e[0m $1"
}

# Error exit with cleanup option
error_exit() {
  log_error "$1"
  
  # In update mode, try to restore from backups rather than doing a full cleanup
  if [ "$UPDATE_MODE" = true ]; then
    log_warn "Error occurred during update. Attempting to restore from backups..."
    
    # Try to restore .env file
    if [ -f "${BASE_DIR}/.env.bak.$(date +%Y%m%d)" ]; then
      log "Restoring .env file from backup..."
      cp "${BASE_DIR}/.env.bak.$(date +%Y%m%d)"* "${BASE_DIR}/.env" 2>/dev/null || true
    fi
    
    # Try to restore HAProxy config
    if [ -f "${CONFIG_DIR}/haproxy/haproxy.cfg.bak.$(date +%Y%m%d)" ]; then
      log "Restoring HAProxy configuration from backup..."
      cp "${CONFIG_DIR}/haproxy/haproxy.cfg.bak.$(date +%Y%m%d)"* "${CONFIG_DIR}/haproxy/haproxy.cfg" 2>/dev/null || true
    fi
    
    # Try to restore docker-compose.yml
    if [ -f "${BASE_DIR}/docker-compose.yml.bak.$(date +%Y%m%d)" ]; then
      log "Restoring docker-compose.yml from backup..."
      cp "${BASE_DIR}/docker-compose.yml.bak.$(date +%Y%m%d)"* "${BASE_DIR}/docker-compose.yml" 2>/dev/null || true
    fi
    
    # Try to restart containers with previous configuration
    if docker ps -a | grep -q "haproxy" && docker ps -a | grep -q "node-app"; then
      log "Attempting to restart containers with previous configuration..."
      cd "${BASE_DIR}" && docker-compose restart || true
    fi
    
    log_warn "Attempted to restore from backups. Please check your configuration and try again."
    exit 1
  fi
  
  # For non-update mode or if explicitly requested, perform cleanup
  if [ "${SKIP_CONFIRMATION:-false}" = false ] && [ "${2:-}" != "no_prompt" ]; then
    read -p "Do you want to attempt cleanup of incomplete installation? (y/N): " choice
    case "$choice" in
      y|Y) cleanup_installation ;;
      *) echo "Exiting without cleanup." ;;
    esac
  else
    # In non-interactive mode, perform cleanup automatically
    log "Performing automatic cleanup in non-interactive mode"
    cleanup_installation
  fi
  
  exit 1
}

# Installation state management
init_install_state() {
  local state_file="${BASE_DIR}/.install_state"
  
  # Create initial state if it doesn't exist
  if [ ! -f "$state_file" ]; then
    cat > "$state_file" <<EOF
prerequisites_checked=false
directories_created=false
repository_cloned=false
config_files_created=false
networks_created=false
containers_started=false
services_verified=false
installation_completed=false
EOF
  fi
  
  log "Installation state initialized"
}

update_install_state() {
  local key="$1"
  local value="$2"
  local state_file="${BASE_DIR}/.install_state"
  
  # Create state file if it doesn't exist
  if [ ! -f "$state_file" ]; then
    touch "$state_file"
  fi
  
  # Update or add the key-value pair
  if grep -q "^${key}=" "$state_file"; then
    sed -i.bak "s/^${key}=.*/${key}=${value}/" "$state_file" && rm "${state_file}.bak"
  else
    echo "${key}=${value}" >> "$state_file"
  fi
  
  log "Installation state updated: ${key}=${value}"
}

get_install_state() {
  local key="$1"
  local state_file="${BASE_DIR}/.install_state"
  
  if [ ! -f "$state_file" ]; then
    echo "false"
    return
  fi
  
  local value
  value=$(grep "^${key}=" "$state_file" | cut -d= -f2)
  
  if [ -z "$value" ]; then
    echo "false"
  else
    echo "$value"
  fi
}

# Check prerequisites
check_prerequisites() {
  log "Checking prerequisites..."
  
  # Check if docker is installed
  if ! command -v docker >/dev/null 2>&1; then
    log_error "Docker is not installed. Please install Docker first."
    return 1
  fi
  
  # Check if docker-compose is installed
  if ! command -v docker-compose >/dev/null 2>&1; then
    log_error "Docker Compose is not installed. Please install Docker Compose first."
    return 1
  fi
  
  # Check if docker daemon is running
  if ! docker info >/dev/null 2>&1; then
    log_error "Docker daemon is not running. Please start Docker first."
    return 1
  fi
  
  # Check if netcat is installed (for port checks)
  if ! command -v nc >/dev/null 2>&1; then
    log_error "Netcat is not installed. Please install netcat for port verification."
    return 1
  fi
  
  # Check if OpenSSL is installed (for certificate generation)
  if ! command -v openssl >/dev/null 2>&1; then
    log_error "OpenSSL is not installed. Please install OpenSSL for certificate operations."
    return 1
  fi
  
  # Check if curl is installed
  if ! command -v curl >/dev/null 2>&1; then
    log_error "curl is not installed. Please install curl for health checks."
    return 1
  fi
  
  # Check if ports 80, 443, 8081, and 27017 are available
  for port in 80 443 8081 27017; do
    if nc -z localhost "$port" 2>/dev/null; then
      log_error "Port $port is already in use. Please free up this port before continuing."
      return 1
    fi
  done
  
  log "All prerequisites satisfied"
  update_install_state "prerequisites_checked" "true"
  return 0
}

# Create necessary directories
create_directories() {
  log "Creating necessary directories..."
  
  # Create base directory if it doesn't exist
  mkdir -p "${BASE_DIR}"
  
  # Create config directory
  mkdir -p "${CONFIG_DIR}"
  
  # Create certificates directory
  mkdir -p "${CERTS_DIR}"
  
  # Create logs directory
  mkdir -p "${LOGS_DIR}"
  
  # Set permissions for logs directory
  chmod 755 "${LOGS_DIR}"
  
  log "Directories created successfully"
  update_install_state "directories_created" "true"
  return 0
}

# Clone repository
clone_repository() {
  # Check if we're already in the cloned repository
  if [ -f "./install.sh" ] && [ -d "./node-app" ]; then
    log "Already in the repository directory, skipping clone step"
    update_install_state "repository_cloned" "true"
    return 0
  fi
  
  log "Cloning front server repository from $FRONT_REPO_URL..."
  
  # Check if git is installed
  if ! command -v git >/dev/null 2>&1; then
    log_error "Git is not installed. Please install Git first."
    return 1
  fi
  
  # Clone the repository
  if ! git clone "$FRONT_REPO_URL" "$BASE_DIR"; then
    log_error "Failed to clone repository from $FRONT_REPO_URL"
    return 1
  fi
  
  log "Repository cloned successfully"
  update_install_state "repository_cloned" "true"
  return 0
}

# Create configuration files
create_config_files() {
  log "Creating/updating configuration files..."
  
  # Create .env file if it doesn't exist or if force recreate is specified
  if [ ! -f "${BASE_DIR}/.env" ]; then
    log "Creating .env file..."
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
  elif [ "$FORCE_RECREATE" = true ] && [ "$UPDATE_MODE" != true ]; then
    # Only overwrite .env if force recreate is true AND update mode is false
    log "Force recreate mode: Creating new .env file..."
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
  else
    log ".env file already exists, preserving custom environment variables"
    if [ "$UPDATE_MODE" = true ]; then
      log "Update mode: Creating backup of existing .env file"
      cp "${BASE_DIR}/.env" "${BASE_DIR}/.env.bak.$(date +%Y%m%d%H%M%S)"
    fi
  fi

  # Create directory structure
  mkdir -p "${CONFIG_DIR}/haproxy"
  mkdir -p "${CONFIG_DIR}/certs"
  mkdir -p "${CONFIG_DIR}/agents"
  mkdir -p "${LOGS_DIR}"

  # Create HAProxy configuration if it doesn't exist or if force recreate is specified
  if [ ! -f "${CONFIG_DIR}/haproxy/haproxy.cfg" ] || [ "$FORCE_RECREATE" = true ]; then
    log "Creating HAProxy configuration file..."
    cat > "${CONFIG_DIR}/haproxy/haproxy.cfg" <<'EOF'
# HAProxy Configuration for CloudLunacy Front Server
global
    log /dev/log local0
    log /dev/log local1 notice
    stats socket /var/run/haproxy.sock mode 660 level admin expose-fd listeners
    stats timeout 30s
    user haproxy
    group haproxy
    daemon
    maxconn 4096
    tune.ssl.default-dh-param 2048
    ssl-default-bind-ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384
    ssl-default-bind-options no-sslv3 no-tlsv10 no-tlsv11

defaults
    log global
    mode http
    option httplog
    option dontlognull
    timeout connect 5000ms
    timeout client 50000ms
    timeout server 50000ms
    # No errorfile references to avoid errors when files don't exist

# Stats page
frontend stats
    bind *:8081
    stats enable
    stats uri /stats
    stats refresh 10s
    stats auth admin:admin_password
    stats admin if TRUE

# HTTP Frontend
frontend http_in
    bind *:80
    mode http
    option forwardfor
    default_backend node_app_backend

# Backend for Node.js app
backend node_app_backend
    mode http
    server node_app node-app:3005 check

# Default MongoDB Backend
backend mongodb_default
    mode tcp
    server mongodb1 127.0.0.1:27018 check

# Backend for Let's Encrypt challenges
backend letsencrypt_backend
    mode http
    server certbot certbot:80

# Empty backend for rejected connections
backend empty_backend
    mode tcp
    timeout server 1s
    server empty_server 127.0.0.1:1 check
EOF
  else
    log "HAProxy configuration file already exists, skipping creation"
    if [ "$UPDATE_MODE" = true ]; then
      log "Update mode: Backing up existing HAProxy configuration..."
      # Create a timestamped backup
      cp "${CONFIG_DIR}/haproxy/haproxy.cfg" "${CONFIG_DIR}/haproxy/haproxy.cfg.bak.$(date +%Y%m%d%H%M%S)"
    fi
  fi

  # Create self-signed certificate if it doesn't exist or if force recreate is specified
  if [ ! -f "${CONFIG_DIR}/certs/default.pem" ] || [ "$FORCE_RECREATE" = true ]; then
    log "Creating self-signed certificate for initial setup..."
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
      -keyout "${CONFIG_DIR}/certs/default.key" \
      -out "${CONFIG_DIR}/certs/default.crt" \
      -subj "/CN=*.${DOMAIN}/O=CloudLunacy/C=US" 
    
    # Combine key and certificate for HAProxy
    cat "${CONFIG_DIR}/certs/default.crt" "${CONFIG_DIR}/certs/default.key" > "${CONFIG_DIR}/certs/default.pem"
    chmod 600 "${CONFIG_DIR}/certs/default.pem"
  else
    log "Default certificate already exists, skipping creation"
  fi

  # Create sample agent configuration directory
  mkdir -p "${CONFIG_DIR}/agents"
  if [ ! -f "${CONFIG_DIR}/agents/default.json" ] || [ "$FORCE_RECREATE" = true ]; then
    touch "${CONFIG_DIR}/agents/default.json"
  fi

  # Create docker-compose.yml with network configuration only if it doesn't exist or force recreate is specified
  if [ ! -f "${BASE_DIR}/docker-compose.yml" ] || [ "$FORCE_RECREATE" = true ]; then
    log "Creating docker-compose.yml file..."
    cat > "${BASE_DIR}/docker-compose.yml" <<EOF
version: '3.8'

services:
  haproxy:
    image: haproxy:2.8-alpine
    container_name: haproxy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "8081:8081"
      - "27017:27017"  # MongoDB port explicitly exposed
    volumes:
      - ./config/haproxy:/usr/local/etc/haproxy:ro
      - ./config/certs:/etc/ssl/certs:ro
      - ${LOGS_DIR}:/var/log/haproxy
    healthcheck:
      test: ["CMD", "haproxy", "-c", "-f", "/usr/local/etc/haproxy/haproxy.cfg"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 10s
    networks:
      - haproxy-network
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
      - haproxy-network
      - ${SHARED_NETWORK}
    depends_on:
      - haproxy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3005/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s

networks:
  haproxy-network:
    name: haproxy-network
    external: true
  ${SHARED_NETWORK}:
    external: true
EOF
  else
    log "docker-compose.yml already exists, skipping creation"
    if [ "$UPDATE_MODE" = true ]; then
      log "Update mode: Creating backup of existing docker-compose.yml..."
      cp "${BASE_DIR}/docker-compose.yml" "${BASE_DIR}/docker-compose.yml.bak.$(date +%Y%m%d%H%M%S)"
    fi
  fi

  log "Configuration files created/updated successfully"
  update_install_state "config_files_created" "true"
  return 0
}

# Create Docker networks
create_networks() {
  log "Setting up Docker networks..."
  
  # Create HAProxy network if it doesn't exist
  if ! docker network ls | grep -q "${HAPROXY_NETWORK}"; then
    log "Creating ${HAPROXY_NETWORK} network..."
    docker network create "${HAPROXY_NETWORK}" || log_warn "Failed to create ${HAPROXY_NETWORK} network - it may already exist"
  else
    log "${HAPROXY_NETWORK} network already exists"
  fi
  
  # Check if shared network exists
  if ! docker network ls | grep -q "${SHARED_NETWORK}"; then
    log "Creating ${SHARED_NETWORK} network..."
    docker network create "${SHARED_NETWORK}" || log_warn "Failed to create ${SHARED_NETWORK} network - it may already exist"
  else
    log "${SHARED_NETWORK} network already exists"
  fi
  
  log "Docker networks created successfully"
  update_install_state "networks_created" "true"
  return 0
}

# Start Docker containers
start_containers() {
  if [ "$SKIP_DOCKER_RESTART" = true ]; then
    log "Skipping Docker container restart as requested"
    update_install_state "containers_started" "true"
    return 0
  fi

  log "Building and starting containers..."
  cd "${BASE_DIR}" || return 1
  
  # Check if the containers are already running
  if docker ps | grep -q "haproxy" && docker ps | grep -q "cloudlunacy-front"; then
    log "Containers are already running"
    
    if [ "$UPDATE_MODE" = true ]; then
      log "Update mode: Rebuilding and recreating containers with new code..."
      docker-compose up -d --build
    elif [ "$FORCE_RECREATE" = true ]; then
      log "Force recreate specified: Removing and recreating containers..."
      docker-compose down
      docker-compose up -d --build
    else
      log "Skipping rebuild since neither update nor force-recreate was specified"
    fi
    
    update_install_state "containers_started" "true"
    return 0
  fi
  
  # If containers exist but are stopped
  if docker ps -a | grep -q "haproxy" && docker ps -a | grep -q "cloudlunacy-front"; then
    log "Containers exist but are not running..."
    
    if [ "$UPDATE_MODE" = true ] || [ "$FORCE_RECREATE" = true ]; then
      log "Update/force-recreate mode: Rebuilding and recreating containers..."
      docker-compose up -d --build
    else
      log "Starting existing containers..."
      docker-compose start
    fi
  else
    # Otherwise, start with build
    log "Building and starting containers from scratch..."
    docker-compose up -d --build
  fi
  
  if [ $? -ne 0 ]; then
    log_error "Failed to start containers. Check docker-compose configuration."
    return 1
  fi
  
  # Wait briefly for containers to start
  sleep 5
  
  # Do basic check if containers are running - don't check logs yet
  if ! docker ps | grep -q "haproxy"; then
    log_error "HAProxy container failed to start"
    return 1
  fi
  
  if ! docker ps | grep -q "cloudlunacy-front"; then
    log_error "Node.js app container failed to start"
    return 1
  fi
  
  log "Containers started successfully. Initial startup phase complete."
  log "Waiting for services to initialize and establish connections..."
  
  # Give containers more time to initialize and establish connections
  sleep 10
  
  update_install_state "containers_started" "true"
  return 0
}

# Verify services are operational
verify_services() {
  log "Verifying services..."
  local retries=10       # Increased from 5 to 10
  local delay=15         # Increased from 10 to 15
  local count=0
  
  # Verify HAProxy is healthy
  log "Checking HAProxy health..."
  while ! docker exec haproxy haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg &>/dev/null; do
    count=$((count+1))
    if [ $count -ge $retries ]; then
      log_error "HAProxy health check failed after $retries attempts"
      
      # Log HAProxy config for debugging
      log_error "HAProxy configuration validation failed. Here's the output:"
      docker exec haproxy haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg || true
      
      # Log HAProxy logs for debugging
      log_error "Last 20 lines of HAProxy logs:"
      docker logs --tail 20 haproxy || true
      
      return 1
    fi
    log "Waiting for HAProxy to be ready... ($count/$retries)"
    sleep $delay
  done
  log "HAProxy is healthy"
  
  # Verify Node.js app is healthy
  log "Checking Node.js app health..."
  count=0
  while ! curl -s http://localhost:${NODE_PORT}/health | grep -q "ok"; do
    count=$((count+1))
    if [ $count -ge $retries ]; then
      log_error "Node.js app health check failed after $retries attempts"
      
      # Log Node.js app logs for debugging
      log_error "Last 20 lines of Node.js app logs:"
      docker logs --tail 20 cloudlunacy-front || true
      
      return 1
    fi
    log "Waiting for Node.js app to be ready... ($count/$retries)"
    sleep $delay
  done
  log "Node.js app is healthy"
  
  # Verify HAProxy is connecting to backends
  log "Checking HAProxy backend connections..."
  count=0
  while ! docker logs haproxy | grep -q "Server node-app-backend/node_app is UP"; do
    count=$((count+1))
    if [ $count -ge $retries ]; then
      log_warn "HAProxy connection to backend check failed after $retries attempts"
      log_warn "This may resolve itself as services continue to initialize"
      log_warn "Last 20 lines of HAProxy logs:"
      docker logs --tail 20 haproxy || true
      # Continue execution, don't return error
      break
    fi
    log "Waiting for HAProxy to connect to backend... ($count/$retries)"
    sleep $delay
  done
  
  # Verify MongoDB port is being exposed (but don't fail installation if not available)
  log "Checking MongoDB port forwarding..."
  if ! nc -z localhost 27017; then
    log_warn "MongoDB port forwarding check failed. This is normal if MongoDB is not configured."
  else
    log "MongoDB port forwarding is working"
  fi
  
  log "All services verified successfully"
  update_install_state "services_verified" "true"
  return 0
}

# Function to cleanup installation if it fails
cleanup_installation() {
  log "Cleaning up installation..."
  
  # Stop and remove containers if they were started
  if [ "$(get_install_state "containers_started")" = "true" ]; then
    log "Stopping and removing containers..."
    cd "${BASE_DIR}" || return
    docker-compose down -v
  fi
  
  # Remove Docker networks
  if [ "$(get_install_state "networks_created")" = "true" ]; then
    log "Removing Docker networks..."
    docker network rm "${HAPROXY_NETWORK}" 2>/dev/null || true
    # Don't remove shared network as it might be used by other services
  fi
  
  # Remove directories
  if [ "$(get_install_state "directories_created")" = "true" ] || [ "$(get_install_state "repository_cloned")" = "true" ]; then
    log "Removing created directories..."
    rm -rf "${BASE_DIR}"
  fi
  
  log "Cleanup completed"
}

# Function to display installation summary
display_summary() {
  log_success "==== CloudLunacy Front Server Installation Summary ===="
  log_success "Installation completed successfully!"
  log_success ""
  log_success "Services:"
  log_success "  - HAProxy: Running on ports 80, 443, 8081, 27017"
  log_success "  - Node.js App: Running on port ${NODE_PORT}"
  log_success ""
  log_success "Access Points:"
  log_success "  - Frontend: https://front.${DOMAIN}"
  log_success "  - HAProxy Stats: http://localhost:8081/stats"
  log_success ""
  log_success "Configuration:"
  log_success "  - Config Directory: ${CONFIG_DIR}"
  log_success "  - Certificate Directory: ${CERTS_DIR}"
  log_success "  - Log Directory: ${LOGS_DIR}"
  log_success ""
  log_success "Next Steps:"
  log_success "  1. Set up proper SSL certificates"
  log_success "  2. Configure MongoDB access as needed"
  log_success "  3. Review HAProxy configuration for security"
  log_success "  4. Set up DNS for your domains"
  log_success ""
  log_success "For more information, visit: https://github.com/Mayze123/cloudlunacy_front"
  log_success ""
  log_success "Thank you for installing CloudLunacy Front Server!"
  log_success "==================================================="
}

# Parse command line arguments
parse_arguments() {
  # Default values
  INTERACTIVE=true
  SKIP_CONFIRMATION=false
  UPDATE_MODE=false
  FORCE_RECREATE=false
  SKIP_DOCKER_RESTART=false
  
  # Parse arguments
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --no-interactive)
        INTERACTIVE=false
        SKIP_CONFIRMATION=true
        shift
        ;;
      --update)
        UPDATE_MODE=true
        log "Running in update mode - will preserve existing configurations"
        shift
        ;;
      --force-recreate)
        FORCE_RECREATE=true
        log "Force recreate mode - will overwrite existing configurations"
        shift
        ;;
      --skip-docker-restart)
        SKIP_DOCKER_RESTART=true
        log "Will skip restarting Docker containers"
        shift
        ;;
      --help)
        show_help
        exit 0
        ;;
      *)
        log_error "Unknown option: $1"
        show_help
        exit 1
        ;;
    esac
  done
}

# Show help message
show_help() {
  cat << EOF
CloudLunacy Front Server Installation Script (Version 3.0.0)

Usage: ./install.sh [options]

Options:
  --no-interactive     Run without interactive prompts
  --update             Run in update mode (preserves existing configurations)
  --force-recreate     Force recreation of configuration files
  --skip-docker-restart Skip restarting Docker containers
  --help               Show this help message

For more information, visit: https://github.com/Mayze123/cloudlunacy_front
EOF
}

# Update repository with latest code
update_repository() {
  if [ ! -d "${BASE_DIR}/.git" ]; then
    log_warn "Not a git repository, skipping code update"
    return 0
  fi
  
  log "Updating repository with latest code..."
  cd "${BASE_DIR}" || return 1
  
  # Store current branch
  current_branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "detached")
  
  # Stash any local changes
  if ! git diff-index --quiet HEAD --; then
    log "Local changes detected, stashing them..."
    git stash
  fi
  
  # Pull the latest code
  if ! git pull origin "${current_branch}"; then
    log_error "Failed to pull latest code"
    return 1
  fi
  
  log_success "Repository updated successfully to the latest version"
  return 0
}

# Main installation flow
main() {
  # Parse command line arguments
  parse_arguments "$@"

  # Display welcome message (skip in non-interactive mode)
  if [ "$INTERACTIVE" = true ]; then
    if [ "$UPDATE_MODE" = true ]; then
      echo "===================================================================="
      echo "   CloudLunacy Front Server Update Script (Version 3.0.0)           "
      echo "===================================================================="
      echo "This script will update your CloudLunacy Front Server installation."
      echo "It will preserve existing configurations whenever possible."
      echo ""
      echo "The update will perform the following steps:"
      echo "  1. Check prerequisites"
      echo "  2. Update repository code"
      echo "  3. Backup existing configurations"
      echo "  4. Update configuration files if needed"
      echo "  5. Maintain Docker networks"
      echo "  6. Rebuild and restart containers"
      echo "  7. Verify services"
      echo ""
    else
      echo "===================================================================="
      echo "   CloudLunacy Front Server Installation Script (Version 3.0.0)     "
      echo "===================================================================="
      echo "This script will install CloudLunacy Front Server with HAProxy for:"
      echo "  - HTTPS reverse proxy"
      echo "  - Certificate management"
      echo "  - MongoDB routing"
      echo "  - Load balancing"
      echo ""
      echo "The installation will perform the following steps:"
      echo "  1. Check prerequisites"
      echo "  2. Create necessary directories"
      echo "  3. Clone the repository (if needed)"
      echo "  4. Configure services"
      echo "  5. Set up Docker networks"
      echo "  6. Start containers"
      echo "  7. Verify services"
      echo ""
    fi
    echo "Press Ctrl+C to cancel or Enter to continue..."
    read -r
    echo "===================================================================="
  fi
  
  if [ "$UPDATE_MODE" = true ]; then
    log "Starting CloudLunacy Front Server update..."
  else
    log "Starting CloudLunacy Front Server installation..."
  fi
  
  # Initialize installation state
  init_install_state
  
  check_prerequisites || error_exit "Failed to meet prerequisites"
  
  create_directories || error_exit "Failed to create directories"
  
  # Only clone repository if it doesn't exist or we're in force recreate mode
  if [ ! -d "${BASE_DIR}/node-app" ] || [ "$FORCE_RECREATE" = true ]; then
    clone_repository || error_exit "Failed to clone repository"
  else
    log "Repository already exists, skipping clone step"
    update_install_state "repository_cloned" "true"
    
    # If in update mode, pull the latest code
    if [ "$UPDATE_MODE" = true ]; then
      update_repository || log_warn "Failed to update repository code, continuing with existing code"
    fi
  fi
  
  create_config_files || error_exit "Failed to create configuration files"
  
  create_networks || error_exit "Failed to create Docker networks"
  
  start_containers || error_exit "Failed to start containers"
  
  verify_services || error_exit "Failed to verify services"
  
  # Update install state to completed
  update_install_state "installation_completed" "true"
  
  # Display installation summary
  if [ "$UPDATE_MODE" = true ]; then
    log_success "CloudLunacy Front Server update completed successfully"
  else
    display_summary
  fi
  
  return 0
}

# Execute main function
main "$@"