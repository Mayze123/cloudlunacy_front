#!/bin/bash
# HAProxy Health Check Script for CloudLunacy
# This script checks the HAProxy configuration and connectivity to backend services

# Colors for better readability
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}[INFO]${NC} Running HAProxy health check..."

# Check if HAProxy container is running
if ! docker ps | grep -q haproxy; then
  echo -e "${RED}[ERROR]${NC} HAProxy container is not running"
  exit 1
fi

# Check if HAProxy configuration is valid
echo -e "${BLUE}[INFO]${NC} Validating HAProxy configuration..."
if ! docker exec haproxy haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg; then
  echo -e "${RED}[ERROR]${NC} HAProxy configuration is invalid"
  exit 1
fi
echo -e "${GREEN}[SUCCESS]${NC} HAProxy configuration is valid"

# Check if HAProxy is listening on required ports
echo -e "${BLUE}[INFO]${NC} Checking HAProxy port bindings..."
for port in 80 443 8081 27017; do
  if ! docker exec haproxy ss -tlnp | grep -q ":$port"; then
    echo -e "${RED}[ERROR]${NC} HAProxy is not listening on port $port"
  else
    echo -e "${GREEN}[SUCCESS]${NC} HAProxy is listening on port $port"
  fi
done

# Check Node.js app health
echo -e "${BLUE}[INFO]${NC} Checking Node.js app health..."
if docker ps | grep -q cloudlunacy-front; then
  # Check if the app is responding to health checks
  if docker exec cloudlunacy-front wget -qO- http://localhost:3005/health | grep -q "ok"; then
    echo -e "${GREEN}[SUCCESS]${NC} Node.js app is healthy"
  else
    echo -e "${RED}[ERROR]${NC} Node.js app health check failed"
  fi
else
  echo -e "${RED}[ERROR]${NC} cloudlunacy-front container is not running"
fi

# Check connectivity between HAProxy and Node.js app
echo -e "${BLUE}[INFO]${NC} Checking connectivity from HAProxy to Node.js app..."

# Install netcat in HAProxy container if not present
if ! docker exec haproxy which nc &> /dev/null; then
  echo -e "${YELLOW}[WARNING]${NC} Installing netcat in HAProxy container..."
  docker exec haproxy apt-get update -qq &> /dev/null
  docker exec haproxy apt-get install -y netcat &> /dev/null
fi

# Test connection to cloudlunacy-front
if docker exec haproxy nc -z cloudlunacy-front 3005 &> /dev/null; then
  echo -e "${GREEN}[SUCCESS]${NC} HAProxy can connect to cloudlunacy-front:3005"
else
  echo -e "${RED}[ERROR]${NC} HAProxy cannot connect to cloudlunacy-front:3005"
  
  # Try alternate hostname
  if docker exec haproxy nc -z node-app 3005 &> /dev/null; then
    echo -e "${GREEN}[SUCCESS]${NC} HAProxy can connect to node-app:3005"
    echo -e "${YELLOW}[WARNING]${NC} HAProxy should use 'node-app' as the server name in backend section"
  fi
  
  # Display hosts file content for debugging
  echo -e "${BLUE}[INFO]${NC} Content of /etc/hosts in HAProxy container:"
  docker exec haproxy cat /etc/hosts
  
  # Try to fix by adding hosts entry
  NODE_APP_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' cloudlunacy-front 2>/dev/null || echo "")
  if [ -n "$NODE_APP_IP" ]; then
    echo -e "${BLUE}[INFO]${NC} Adding cloudlunacy-front to hosts file in HAProxy container..."
    docker exec haproxy bash -c "grep -v cloudlunacy-front /etc/hosts > /tmp/hosts && echo '$NODE_APP_IP cloudlunacy-front node-app' >> /tmp/hosts && cat /tmp/hosts > /etc/hosts"
    
    # Test again
    if docker exec haproxy nc -z cloudlunacy-front 3005 &> /dev/null; then
      echo -e "${GREEN}[SUCCESS]${NC} HAProxy can now connect to cloudlunacy-front:3005"
    else
      echo -e "${RED}[ERROR]${NC} HAProxy still cannot connect to cloudlunacy-front:3005 after hosts file update"
    fi
  fi
fi

# Check if HAProxy backend shows the node app server as UP
echo -e "${BLUE}[INFO]${NC} Checking HAProxy backend status..."
docker exec haproxy bash -c "echo 'show stat' | socat unix-connect:/var/run/haproxy.sock stdio" | grep node-app-backend

echo -e "${BLUE}[INFO]${NC} Health check completed. If issues persist, try running the fix-networking.sh script."