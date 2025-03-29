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