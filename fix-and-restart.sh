#!/bin/bash
# Script to fix container connectivity issues and restart services

# Color codes for output formatting
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}[INFO]${NC} Starting CloudLunacy Front service fix and restart process..."

# Step 1: Get the IP address of the Node.js container to update HAProxy config
echo -e "${BLUE}[INFO]${NC} Getting IP address of cloudlunacy-front container..."
NODE_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' cloudlunacy-front 2>/dev/null || echo "")

if [ -z "$NODE_IP" ]; then
    echo -e "${YELLOW}[WARNING]${NC} Could not get IP address of cloudlunacy-front container."
    echo -e "${YELLOW}[WARNING]${NC} HAProxy will rely on Docker DNS resolution."
else
    echo -e "${GREEN}[SUCCESS]${NC} Found Node.js container IP: $NODE_IP"
    
    # Update the IP address in the HAProxy config if needed
    echo -e "${BLUE}[INFO]${NC} Updating HAProxy backend configuration with Node.js app IP..."
    sed -i "s/server node_app_ip 172.20.0.3:3005/server node_app_ip $NODE_IP:3005/" ./config/haproxy/haproxy.cfg
fi

# Step 2: Make the fix-networking.sh script executable if it exists
if [ -f "./config/haproxy/fix-networking.sh" ]; then
    echo -e "${BLUE}[INFO]${NC} Making fix-networking.sh script executable..."
    chmod +x ./config/haproxy/fix-networking.sh
fi

# Step 3: Make the health-check.sh script executable if it exists
if [ -f "./config/haproxy/health-check.sh" ]; then
    echo -e "${BLUE}[INFO]${NC} Making health-check.sh script executable..."
    chmod +x ./config/haproxy/health-check.sh
fi

# Step 4: Restart containers
echo -e "${BLUE}[INFO]${NC} Restarting containers..."
docker-compose down
docker-compose up -d

# Step 5: Wait for containers to start
echo -e "${BLUE}[INFO]${NC} Waiting for containers to start..."
sleep 10

# Step 6: Check if containers are running
echo -e "${BLUE}[INFO]${NC} Checking container status..."
if docker ps | grep -q haproxy && docker ps | grep -q cloudlunacy-front; then
    echo -e "${GREEN}[SUCCESS]${NC} Containers are running!"
else
    echo -e "${RED}[ERROR]${NC} One or more containers are not running."
    echo "Container status:"
    docker ps
fi

# Step 7: Add hosts entry in HAProxy container if needed
echo -e "${BLUE}[INFO]${NC} Adding hosts entry in HAProxy container..."
if [ -n "$NODE_IP" ]; then
    docker exec haproxy bash -c "echo '$NODE_IP cloudlunacy-front node-app' >> /etc/hosts"
    echo -e "${GREEN}[SUCCESS]${NC} Added hosts entry in HAProxy container."
fi

# Step 8: Run the health check script if it exists
if [ -f "./config/haproxy/health-check.sh" ]; then
    echo -e "${BLUE}[INFO]${NC} Running health check..."
    ./config/haproxy/health-check.sh
fi

echo -e "${GREEN}[SUCCESS]${NC} Fix and restart process completed!"
echo -e "${BLUE}[INFO]${NC} If issues persist, check container logs with 'docker logs haproxy' and 'docker logs cloudlunacy-front'"