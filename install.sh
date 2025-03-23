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
  
  # Ask if user wants to attempt cleanup
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

  # Create directory structure
  mkdir -p "${CONFIG_DIR}/haproxy"
  mkdir -p "${CONFIG_DIR}/certs"
  mkdir -p "${CONFIG_DIR}/agents"
  mkdir -p "${LOGS_DIR}"

  # Create HAProxy configuration
  cat > "${CONFIG_DIR}/haproxy/haproxy.cfg" <<'EOF'
# HAProxy Configuration for CloudLunacy Front Server
global
    log /dev/log local0
    log /dev/log local1 notice
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
    errorfile 400 /etc/haproxy/errors/400.http
    errorfile 403 /etc/haproxy/errors/403.http
    errorfile 408 /etc/haproxy/errors/408.http
    errorfile 500 /etc/haproxy/errors/500.http
    errorfile 502 /etc/haproxy/errors/502.http
    errorfile 503 /etc/haproxy/errors/503.http
    errorfile 504 /etc/haproxy/errors/504.http

# Stats page
frontend stats
    bind *:8081
    stats enable
    stats uri /stats
    stats refresh 10s
    stats auth admin:admin_password
    stats admin if TRUE

# HTTP Frontend
frontend http
    bind *:80
    mode http
    option forwardfor
    http-request redirect scheme https unless { ssl_fc }

# HTTPS Frontend
frontend https
    bind *:443 ssl crt /etc/ssl/certs/default.pem
    mode http
    option forwardfor
    
    # ACL for node-app
    acl host_node_app hdr(host) -i front.cloudlunacy.local
    
    # Route to backend based on host
    use_backend node_app if host_node_app
    
    # Default backend
    default_backend node_app

# Node.js App Backend
backend node_app
    mode http
    option forwardfor
    server node1 node-app:3005 check

# MongoDB Frontend
frontend mongodb
    bind *:27017 ssl crt /etc/ssl/certs/default.pem
    mode tcp
    option tcplog
    
    # Default MongoDB service
    default_backend mongodb_default

# Default MongoDB Backend
backend mongodb_default
    mode tcp
    server mongodb1 127.0.0.1:27018 check
EOF

  # Create a self-signed default certificate for initial setup
  log "Creating self-signed certificate for initial setup..."
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout "${CONFIG_DIR}/certs/default.key" \
    -out "${CONFIG_DIR}/certs/default.crt" \
    -subj "/CN=*.${DOMAIN}/O=CloudLunacy/C=US" 
  
  # Combine key and certificate for HAProxy
  cat "${CONFIG_DIR}/certs/default.crt" "${CONFIG_DIR}/certs/default.key" > "${CONFIG_DIR}/certs/default.pem"
  chmod 600 "${CONFIG_DIR}/certs/default.pem"

  # Create sample agent configuration directory
  mkdir -p "${CONFIG_DIR}/agents"
  touch "${CONFIG_DIR}/agents/default.json"

  # Create docker-compose.yml with network configuration
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
  ${SHARED_NETWORK}:
    external: true
EOF

  log "Configuration files created successfully"
  update_install_state "config_files_created" "true"
  return 0
}

# Create Docker networks
create_networks() {
  log "Setting up Docker networks..."
  
  # Create HAProxy network if it doesn't exist
  if ! docker network ls | grep -q "${HAPROXY_NETWORK}"; then
    log "Creating ${HAPROXY_NETWORK} network..."
    docker network create "${HAPROXY_NETWORK}" || error_exit "Failed to create ${HAPROXY_NETWORK} network"
  else
    log "${HAPROXY_NETWORK} network already exists"
  fi
  
  # Check if shared network exists
  if ! docker network ls | grep -q "${SHARED_NETWORK}"; then
    log "Creating ${SHARED_NETWORK} network..."
    docker network create "${SHARED_NETWORK}" || error_exit "Failed to create ${SHARED_NETWORK} network"
  else
    log "${SHARED_NETWORK} network already exists"
  fi
  
  log "Docker networks created successfully"
  update_install_state "networks_created" "true"
  return 0
}

# Start Docker containers
start_containers() {
  log "Building and starting containers..."
  cd "${BASE_DIR}" || return 1
  docker-compose up -d --build
  
  if [ $? -ne 0 ]; then
    log_error "Failed to start containers. Check docker-compose configuration."
    return 1
  fi
  
  # Check if containers are running
  if ! docker ps | grep -q "haproxy"; then
    log_error "HAProxy container failed to start. Checking logs..."
    docker-compose logs haproxy
    return 1
  fi
  
  if ! docker ps | grep -q "node-app"; then
    log_error "Node.js app container failed to start. Checking logs..."
    docker-compose logs node-app
    return 1
  fi
  
  log "Containers started successfully"
  update_install_state "containers_started" "true"
  return 0
}

# Verify services are operational
verify_services() {
  log "Verifying services..."
  local retries=5
  local delay=10
  local count=0
  
  # Verify HAProxy is healthy
  log "Checking HAProxy health..."
  while ! docker exec haproxy haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg &>/dev/null; do
    count=$((count+1))
    if [ $count -ge $retries ]; then
      log_error "HAProxy health check failed after $retries attempts"
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
      return 1
    fi
    log "Waiting for Node.js app to be ready... ($count/$retries)"
    sleep $delay
  done
  log "Node.js app is healthy"
  
  # Verify MongoDB port is being exposed
  log "Checking MongoDB port forwarding..."
  if ! nc -z localhost 27017; then
    log_error "MongoDB port forwarding check failed"
    return 1
  fi
  log "MongoDB port forwarding is working"
  
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
  
  # Parse arguments
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --no-interactive)
        INTERACTIVE=false
        SKIP_CONFIRMATION=true
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
  --no-interactive    Run without interactive prompts
  --help              Show this help message

For more information, visit: https://github.com/Mayze123/cloudlunacy_front
EOF
}

# Main installation flow
main() {
  # Parse command line arguments
  parse_arguments "$@"

  # Display welcome message (skip in non-interactive mode)
  if [ "$INTERACTIVE" = true ]; then
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
    echo "  3. Clone the repository"
    echo "  4. Configure services"
    echo "  5. Set up Docker networks"
    echo "  6. Start containers"
    echo "  7. Verify services"
    echo ""
    echo "Press Ctrl+C to cancel or Enter to continue..."
    read -r
    echo "===================================================================="
  fi
  
  log "Starting CloudLunacy Front Server installation..."
  
  # Initialize installation state
  init_install_state
  
  check_prerequisites || error_exit "Failed to meet prerequisites"
  
  create_directories || error_exit "Failed to create directories"
  
  clone_repository || error_exit "Failed to clone repository"
  
  create_config_files || error_exit "Failed to create configuration files"
  
  create_networks || error_exit "Failed to create Docker networks"
  
  start_containers || error_exit "Failed to start containers"
  
  verify_services || error_exit "Failed to verify services"
  
  # Update install state to completed
  update_install_state "installation_completed" "true"
  
  # Display installation summary
  display_summary
  
  log "Installation completed successfully"
  return 0
}

# Execute main function
main "$@"