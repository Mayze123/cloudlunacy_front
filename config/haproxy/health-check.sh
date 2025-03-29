#!/bin/sh
set -e

# Colors for better readability
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

echo "Running comprehensive health check for CloudLunacy services..."

# HAProxy container name
HAPROXY_CONTAINER="${HAPROXY_CONTAINER:-haproxy}"
NODE_APP_CONTAINER="${NODE_APP_CONTAINER:-cloudlunacy-front}"

# Check if HAProxy container is running
echo "\n${YELLOW}Checking HAProxy container status:${NC}"
HAPROXY_RUNNING=$(docker ps -q -f "name=${HAPROXY_CONTAINER}" | wc -l)
if [ "$HAPROXY_RUNNING" -eq "1" ]; then
    echo "${GREEN}✅ HAProxy container is running${NC}"
else
    echo "${RED}❌ HAProxy container is not running!${NC}"
fi

# Check if HAProxy has valid configuration
echo "\n${YELLOW}Checking HAProxy configuration:${NC}"
if docker exec ${HAPROXY_CONTAINER} haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg > /dev/null 2>&1; then
    echo "${GREEN}✅ HAProxy configuration is valid${NC}"
else
    echo "${RED}❌ HAProxy configuration is invalid!${NC}"
    echo "\nDetailed errors:"
    docker exec ${HAPROXY_CONTAINER} haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg
fi

# Check HAProxy process
echo "\n${YELLOW}Checking HAProxy process:${NC}"
HAPROXY_PROCESS=$(docker exec ${HAPROXY_CONTAINER} ps -ef | grep -v grep | grep haproxy | wc -l)
if [ "$HAPROXY_PROCESS" -gt "0" ]; then
    echo "${GREEN}✅ HAProxy process is running${NC}"
else
    echo "${RED}❌ HAProxy process is not running!${NC}"
fi

# Check if node-app service is running
echo "\n${YELLOW}Checking node-app service:${NC}"
NODE_APP_RUNNING=$(docker ps -q -f "name=${NODE_APP_CONTAINER}" | wc -l)
if [ "$NODE_APP_RUNNING" -eq "1" ]; then
    echo "${GREEN}✅ Node App container is running${NC}"
else
    echo "${RED}❌ Node App container is not running!${NC}"
fi

# Check if node-app is reachable from HAProxy
echo "\n${YELLOW}Checking connectivity to node-app from HAProxy:${NC}"
if docker exec ${HAPROXY_CONTAINER} ping -c 1 node-app > /dev/null 2>&1; then
    echo "${GREEN}✅ Node App service is reachable from HAProxy${NC}"
else
    echo "${RED}❌ Node App service is not reachable from HAProxy!${NC}"
    echo "\nChecking docker network configuration:"
    HAPROXY_NETWORKS=$(docker inspect ${HAPROXY_CONTAINER} -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}')
    NODE_APP_NETWORKS=$(docker inspect ${NODE_APP_CONTAINER} -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}')
    echo "HAProxy container is connected to networks: $HAPROXY_NETWORKS"
    echo "Node App container is connected to networks: $NODE_APP_NETWORKS"
fi

# Test if node-app port is open
echo "\n${YELLOW}Testing if node-app port is open:${NC}"
if docker exec ${HAPROXY_CONTAINER} nc -zv node-app 3005 > /dev/null 2>&1; then
    echo "${GREEN}✅ Node App port 3005 is open and accepting connections${NC}"
else
    echo "${RED}❌ Node App port 3005 is closed or not accepting connections!${NC}"
    echo "\nChecking node-app container logs:"
    docker logs --tail 20 ${NODE_APP_CONTAINER}
fi

# Check HAProxy stats
echo "\n${YELLOW}Checking HAProxy stats:${NC}"
STATS=$(docker exec ${HAPROXY_CONTAINER} echo "show stat" | socat unix-connect:/var/run/haproxy.sock stdio)
if [ -n "$STATS" ]; then
    # Extract and summarize backend status
    echo "${GREEN}✅ HAProxy stats socket is responding${NC}"
    echo "\nBackend Status Summary:"
    echo "$STATS" | grep -E "BACKEND|node-app-backend" | awk -F, '{printf "%-20s %-10s %-10s\n", $1, $2, $18}'
else
    echo "${RED}❌ HAProxy stats socket is not responding!${NC}"
fi

echo "\n${YELLOW}Health check completed.${NC}" 