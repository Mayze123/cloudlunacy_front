#!/bin/bash
set -e

# Colors for better readability
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}Fixing network connectivity between HAProxy and node-app...${NC}"

# Container names
HAPROXY_CONTAINER="${HAPROXY_CONTAINER:-haproxy}"
NODE_APP_CONTAINER="${NODE_APP_CONTAINER:-cloudlunacy-front}"

# Check if containers exist
echo -e "\n${YELLOW}Checking container existence:${NC}"
HAPROXY_EXISTS=$(docker ps -a -q -f "name=${HAPROXY_CONTAINER}" | wc -l)
NODE_APP_EXISTS=$(docker ps -a -q -f "name=${NODE_APP_CONTAINER}" | wc -l)

if [ "$HAPROXY_EXISTS" -eq "0" ]; then
    echo -e "${RED}HAProxy container not found!${NC}"
    exit 1
fi

if [ "$NODE_APP_EXISTS" -eq "0" ]; then
    echo -e "${RED}Node App container not found!${NC}"
    exit 1
fi

echo -e "${GREEN}Both containers exist.${NC}"

# Create networks if they don't exist
echo -e "\n${YELLOW}Checking Docker networks:${NC}"
FRONTEND_NETWORK="haproxy-network"
BACKEND_NETWORK="cloudlunacy-network"

# Check and create frontend network
if ! docker network inspect "$FRONTEND_NETWORK" >/dev/null 2>&1; then
    echo -e "Creating frontend network: $FRONTEND_NETWORK"
    docker network create "$FRONTEND_NETWORK"
else
    echo -e "Frontend network $FRONTEND_NETWORK already exists."
fi

# Check and create backend network
if ! docker network inspect "$BACKEND_NETWORK" >/dev/null 2>&1; then
    echo -e "Creating backend network: $BACKEND_NETWORK"
    docker network create "$BACKEND_NETWORK"
else
    echo -e "Backend network $BACKEND_NETWORK already exists."
fi

# Connect containers to networks
echo -e "\n${YELLOW}Connecting containers to networks:${NC}"

# Connect HAProxy to networks
if ! docker network inspect "$FRONTEND_NETWORK" | grep -q "$HAPROXY_CONTAINER"; then
    echo -e "Connecting HAProxy to $FRONTEND_NETWORK..."
    docker network connect "$FRONTEND_NETWORK" "$HAPROXY_CONTAINER"
else
    echo -e "HAProxy already connected to $FRONTEND_NETWORK."
fi

if ! docker network inspect "$BACKEND_NETWORK" | grep -q "$HAPROXY_CONTAINER"; then
    echo -e "Connecting HAProxy to $BACKEND_NETWORK..."
    docker network connect "$BACKEND_NETWORK" "$HAPROXY_CONTAINER"
else
    echo -e "HAProxy already connected to $BACKEND_NETWORK."
fi

# Connect Node App to networks
if ! docker network inspect "$FRONTEND_NETWORK" | grep -q "$NODE_APP_CONTAINER"; then
    echo -e "Connecting Node App to $FRONTEND_NETWORK..."
    docker network connect "$FRONTEND_NETWORK" "$NODE_APP_CONTAINER"
else
    echo -e "Node App already connected to $FRONTEND_NETWORK."
fi

if ! docker network inspect "$BACKEND_NETWORK" | grep -q "$NODE_APP_CONTAINER"; then
    echo -e "Connecting Node App to $BACKEND_NETWORK..."
    docker network connect "$BACKEND_NETWORK" "$NODE_APP_CONTAINER"
else
    echo -e "Node App already connected to $BACKEND_NETWORK."
fi

# Restart containers to apply network changes
echo -e "\n${YELLOW}Restarting containers to apply network changes:${NC}"
echo -e "Restarting Node App container..."
docker restart "$NODE_APP_CONTAINER"
echo -e "Restarting HAProxy container..."
docker restart "$HAPROXY_CONTAINER"

echo -e "\n${YELLOW}Waiting for services to start...${NC}"
sleep 5

# Test connectivity
echo -e "\n${YELLOW}Testing connectivity:${NC}"
if docker exec "$HAPROXY_CONTAINER" ping -c 1 node-app >/dev/null 2>&1; then
    echo -e "${GREEN}✅ HAProxy can now reach node-app!${NC}"
else
    echo -e "${RED}❌ HAProxy still cannot reach node-app. Further troubleshooting needed.${NC}"
    
    # Display connectivity debug info
    echo -e "\n${YELLOW}Network debug information:${NC}"
    echo -e "\nHAProxy container network settings:"
    docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$HAPROXY_CONTAINER"
    
    echo -e "\nNode App container network settings:"
    docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$NODE_APP_CONTAINER"
    
    echo -e "\nTry manually adding the following to /etc/hosts in the HAProxy container:"
    echo -e "docker exec $HAPROXY_CONTAINER sh -c \"echo '$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' $NODE_APP_CONTAINER) node-app' >> /etc/hosts\""
fi

# Print health check command
echo -e "\n${YELLOW}Run the health check script to verify:${NC}"
echo -e "${GREEN}./config/haproxy/health-check.sh${NC}"

echo -e "\n${YELLOW}Network troubleshooting completed.${NC}"

#!/bin/bash
# Network Diagnostics and Fix Script for CloudLunacy
# This script checks container connectivity and DNS resolution

set -e

# Function for logging
log_info() {
  echo -e "\e[34m[INFO]\e[0m $1"
}

log_error() {
  echo -e "\e[31m[ERROR]\e[0m $1" >&2
}

log_success() {
  echo -e "\e[32m[SUCCESS]\e[0m $1"
}

# Check if running inside HAProxy container
if [ ! -f "/usr/local/etc/haproxy/haproxy.cfg" ]; then
  log_error "This script should be run inside the HAProxy container."
  exit 1
fi

# Install networking tools if needed
if ! command -v dig &> /dev/null || ! command -v nslookup &> /dev/null || ! command -v ping &> /dev/null; then
  log_info "Installing necessary network diagnostic tools..."
  apt-get update &> /dev/null
  apt-get install -y dnsutils iputils-ping net-tools &> /dev/null
  log_success "Network tools installed."
fi

# Check DNS resolution
log_info "Checking DNS resolution for critical services..."

# Define critical containers to check
CONTAINERS=("cloudlunacy-front" "haproxy" "node-app")
FIXED=0

for CONTAINER in "${CONTAINERS[@]}"; do
  log_info "Testing DNS resolution for $CONTAINER..."
  
  # Try DNS resolution
  if ! nslookup $CONTAINER &> /dev/null; then
    log_error "Cannot resolve $CONTAINER via DNS."
    
    # Check if Docker socket is available
    if [ -S /var/run/docker.sock ]; then
      log_info "Docker socket available. Attempting to find container IP..."
      
      # We need to find a way to get the container IP address
      if command -v docker &> /dev/null; then
        CONTAINER_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' $CONTAINER 2>/dev/null || echo "")
        
        if [ -n "$CONTAINER_IP" ]; then
          log_info "Found IP for $CONTAINER: $CONTAINER_IP"
          
          # Add entry to hosts file
          log_info "Adding entry to /etc/hosts..."
          grep -v "$CONTAINER" /etc/hosts > /tmp/hosts
          echo "$CONTAINER_IP $CONTAINER" >> /tmp/hosts
          cat /tmp/hosts > /etc/hosts
          
          log_success "Added $CONTAINER ($CONTAINER_IP) to hosts file."
          FIXED=$((FIXED+1))
          
          # Test the fix
          if nslookup $CONTAINER &> /dev/null; then
            log_success "DNS resolution for $CONTAINER now working."
          else
            log_error "DNS resolution for $CONTAINER still failing."
          fi
        else
          log_error "Could not determine IP for $CONTAINER."
        fi
      else
        log_error "Docker CLI not available. Cannot get container IP."
      fi
    else
      log_error "Docker socket not available. Cannot fix DNS resolution."
    fi
  else
    log_success "DNS resolution for $CONTAINER working properly."
    
    # Test ping to verify network connectivity
    if ping -c 1 -W 1 $CONTAINER &> /dev/null; then
      log_success "Network connectivity to $CONTAINER confirmed."
    else
      log_warn "DNS resolution works but ping fails for $CONTAINER. This may be expected if ICMP is blocked."
    fi
  fi
done

# If we fixed some entries, validate HAProxy config
if [ $FIXED -gt 0 ]; then
  log_info "Fixed $FIXED DNS entries. Validating HAProxy configuration..."
  
  if haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg; then
    log_success "HAProxy configuration is valid. Ready to restart."
  else
    log_error "HAProxy configuration is invalid after DNS fixes."
  fi
else
  log_info "No DNS fixes required."
fi

# Test direct TCP connection to Node.js app
log_info "Testing TCP connection to Node.js app on port 3005..."

if nc -z cloudlunacy-front 3005 &> /dev/null; then
  log_success "TCP connection to cloudlunacy-front:3005 successful."
else
  log_error "Cannot establish TCP connection to cloudlunacy-front:3005."
  log_info "This could indicate that the Node.js app isn't running or is not listening on that port."
  
  # Try alternate container name
  if nc -z node-app 3005 &> /dev/null; then
    log_success "TCP connection to node-app:3005 successful."
    log_info "Consider updating HAProxy configuration to use node-app instead of cloudlunacy-front."
  fi
fi

log_info "Network diagnostic completed. If issues persist, check container logs and network configurations."