#!/bin/bash

set -e

# Colors for better readability
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== HAProxy Data Plane API Diagnosis and Fix Script ===${NC}"

# Check if running as root
if [ "$(id -u)" -ne 0 ]; then
  echo -e "${RED}This script must be run as root${NC}"
  exit 1
fi

echo -e "${YELLOW}Step 1: Checking if HAProxy container is running...${NC}"
if ! docker ps | grep -q haproxy; then
  echo -e "${RED}HAProxy container is not running!${NC}"
  exit 1
fi
echo -e "${GREEN}HAProxy container is running.${NC}"

echo -e "${YELLOW}Step 2: Checking Data Plane API configuration...${NC}"
docker exec haproxy cat /usr/local/etc/haproxy/dataplaneapi.yml
echo ""

echo -e "${YELLOW}Step 3: Verifying Data Plane API binary exists...${NC}"
if ! docker exec haproxy which dataplaneapi; then
  echo -e "${RED}Data Plane API binary not found!${NC}"
  echo -e "${YELLOW}Installing Data Plane API...${NC}"
  
  docker exec haproxy bash -c '
    apt-get update && 
    apt-get install -y wget curl unzip && 
    cd /tmp && 
    wget https://github.com/haproxytech/dataplaneapi/releases/latest/download/dataplaneapi_linux_amd64.zip && 
    unzip dataplaneapi_linux_amd64.zip && 
    mv dataplaneapi /usr/local/bin/ && 
    chmod +x /usr/local/bin/dataplaneapi && 
    rm dataplaneapi_linux_amd64.zip
  '
  
  if ! docker exec haproxy which dataplaneapi; then
    echo -e "${RED}Failed to install Data Plane API!${NC}"
    exit 1
  fi
  echo -e "${GREEN}Data Plane API installed successfully.${NC}"
else
  echo -e "${GREEN}Data Plane API binary found.${NC}"
fi

echo -e "${YELLOW}Step 4: Checking necessary directories and permissions...${NC}"
docker exec haproxy bash -c '
  mkdir -p /etc/haproxy/dataplaneapi /var/lib/haproxy/backups /tmp/certs/certs /tmp/certs/private /etc/haproxy/maps /etc/haproxy/spoe
  chown -R haproxy:haproxy /etc/haproxy /var/lib/haproxy /tmp/certs
  ls -la /etc/haproxy
  ls -la /var/run/haproxy.sock
'

echo -e "${YELLOW}Step 5: Attempting to manually start Data Plane API...${NC}"
docker exec -d haproxy bash -c 'dataplaneapi -f /usr/local/etc/haproxy/dataplaneapi.yml > /var/log/dataplaneapi.log 2>&1 &'

echo -e "${YELLOW}Waiting for Data Plane API to start (10 seconds)...${NC}"
sleep 10

echo -e "${YELLOW}Step 6: Checking if Data Plane API is running...${NC}"
if docker exec haproxy ps aux | grep -q dataplaneapi; then
  echo -e "${GREEN}Data Plane API process is running.${NC}"
else
  echo -e "${RED}Data Plane API failed to start!${NC}"
fi

echo -e "${YELLOW}Step 7: Checking Data Plane API logs...${NC}"
docker exec haproxy cat /var/log/dataplaneapi.log || echo -e "${RED}No log file found${NC}"

echo -e "${YELLOW}Step 8: Testing Data Plane API health endpoint...${NC}"
if docker exec haproxy curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5555/v3/health | grep -q "200"; then
  echo -e "${GREEN}Data Plane API is healthy!${NC}"
else
  echo -e "${RED}Data Plane API health check failed!${NC}"
  
  # Get more debugging information
  echo -e "${YELLOW}Debugging: Checking network status...${NC}"
  docker exec haproxy netstat -tulpn | grep 5555 || echo "No process listening on port 5555"
  
  echo -e "${YELLOW}Debugging: Trying verbose startup...${NC}"
  docker exec haproxy bash -c 'dataplaneapi -f /usr/local/etc/haproxy/dataplaneapi.yml -debug'
fi

echo -e "${YELLOW}Step 9: Checking HAProxy socket...${NC}"
docker exec haproxy bash -c 'ls -la /var/run/haproxy.sock'
docker exec haproxy bash -c 'stat /var/run/haproxy.sock || echo "Socket not found"'

echo -e "${YELLOW}Step 10: Verifying HAProxy configuration...${NC}"
docker exec haproxy haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg

echo -e "${GREEN}=== Diagnosis Complete ===${NC}"
echo -e "If Data Plane API is still not running, you may need to:"
echo -e "1. Check for more detailed logs"
echo -e "2. Verify the haproxy.cfg global section includes 'stats socket /var/run/haproxy.sock mode 660 level admin expose-fd listeners'"
echo -e "3. Verify there are no conflicting processes on port 5555"
echo -e "4. Check HAProxy version compatibility with Data Plane API"