#!/bin/bash

# Colors for better readability
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== HAProxy Data Plane API Diagnosis Script ===${NC}"

echo -e "${YELLOW}Step 1: Checking HAProxy container status...${NC}"
docker ps -f name=haproxy --format "{{.Status}}"

echo -e "${YELLOW}Step 2: Checking HAProxy configuration...${NC}"
echo -e "${YELLOW}---- Global section of HAProxy config ----${NC}"
docker exec haproxy grep -A 15 "^global" /usr/local/etc/haproxy/haproxy.cfg

echo -e "\n${YELLOW}---- Runtime API socket configuration ----${NC}"
docker exec haproxy grep -i "stats socket" /usr/local/etc/haproxy/haproxy.cfg

echo -e "\n${YELLOW}Step 3: Checking Data Plane API binary...${NC}"
docker exec haproxy bash -c 'which dataplaneapi || echo "Binary not found"'
docker exec haproxy bash -c 'dataplaneapi -version || echo "Cannot determine version"'

echo -e "\n${YELLOW}Step 4: Checking Data Plane API configuration...${NC}"
docker exec haproxy cat /usr/local/etc/haproxy/dataplaneapi.yml | grep -A 8 "haproxy:" || echo "Config section not found"

echo -e "\n${YELLOW}Step 5: Checking runtime socket existence and permissions...${NC}"
docker exec haproxy bash -c 'ls -la /var/run/haproxy.sock 2>/dev/null || echo "Socket does not exist"'

echo -e "\n${YELLOW}Step 6: Checking process status...${NC}"
docker exec haproxy ps aux | grep haproxy

echo -e "\n${YELLOW}Step 7: Checking listen ports...${NC}"
docker exec haproxy bash -c 'netstat -tunlp 2>/dev/null | grep 5555 || echo "Nothing listening on port 5555"'

echo -e "\n${YELLOW}Step 8: Attempting to manually start Data Plane API with debug output...${NC}"
docker exec haproxy bash -c 'dataplaneapi -f /usr/local/etc/haproxy/dataplaneapi.yml -debug 2>&1 | head -n 20' || echo "Failed to run Data Plane API"

echo -e "\n${YELLOW}Step 9: Checking Data Plane API logs...${NC}"
docker exec haproxy bash -c 'cat /var/log/dataplaneapi.log 2>/dev/null || echo "No log file found"'

echo -e "\n${YELLOW}Step 10: Checking directory permissions...${NC}"
docker exec haproxy bash -c 'ls -la /etc/haproxy/dataplaneapi /var/lib/haproxy 2>/dev/null || echo "Directories do not exist"'

echo -e "\n${YELLOW}Step 11: Checking HAProxy version compatibility...${NC}"
docker exec haproxy haproxy -v

echo -e "\n${GREEN}=== Diagnosis Complete ===${NC}"
echo -e "This information should help identify why the Data Plane API is failing to start."