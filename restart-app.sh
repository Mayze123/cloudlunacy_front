#!/bin/bash
# Script to restart the CloudLunacy Front Server application

# Set color codes for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}[INFO]${NC} Restarting CloudLunacy Front Server services..."

# Step 1: Stop containers
echo -e "${BLUE}[INFO]${NC} Stopping existing containers..."
docker-compose stop

# Step 2: Start containers
echo -e "${BLUE}[INFO]${NC} Starting containers..."
docker-compose up -d

# Step 3: Wait for services to initialize
echo -e "${BLUE}[INFO]${NC} Waiting for services to initialize (30 seconds)..."
sleep 30

# Step 4: Check container status
echo -e "${BLUE}[INFO]${NC} Checking container status..."
if docker ps | grep -q haproxy && docker ps | grep -q cloudlunacy-front; then
    echo -e "${GREEN}[SUCCESS]${NC} Both containers are running!"
else
    echo -e "${RED}[ERROR]${NC} One or more containers failed to start."
    echo "Current containers:"
    docker ps
fi

# Step 5: Check Node.js app health
echo -e "${BLUE}[INFO]${NC} Checking Node.js app health..."
if curl -s http://localhost:3005/health | grep -q "ok"; then
    echo -e "${GREEN}[SUCCESS]${NC} Node.js app is healthy and responding!"
else
    echo -e "${YELLOW}[WARNING]${NC} Node.js app health check failed. Checking logs..."
    echo -e "${YELLOW}[WARNING]${NC} Last 20 lines of Node.js app logs:"
    docker logs cloudlunacy-front --tail 20
fi

# Step 6: Check HAProxy health
echo -e "${BLUE}[INFO]${NC} Checking HAProxy health..."
if docker exec haproxy haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg &> /dev/null; then
    echo -e "${GREEN}[SUCCESS]${NC} HAProxy configuration is valid!"
    
    # Check if HAProxy stats page is accessible
    if curl -s http://localhost:8081/stats | grep -q "HAProxy"; then
        echo -e "${GREEN}[SUCCESS]${NC} HAProxy stats page is accessible!"
    else
        echo -e "${YELLOW}[WARNING]${NC} HAProxy stats page is not accessible."
    fi
else
    echo -e "${RED}[ERROR]${NC} HAProxy configuration is invalid."
    echo "HAProxy config check output:"
    docker exec haproxy haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg
fi

echo -e "${GREEN}[SUCCESS]${NC} Service restart completed!"
echo -e "${BLUE}[INFO]${NC} If you still see issues, check the logs with 'docker logs cloudlunacy-front' or 'docker logs haproxy'"