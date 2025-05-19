#!/bin/bash

# Script to verify Traefik/Consul configuration and test app routing
# 
# This script checks that:
# 1. Consul KV entries exist for your routers/services
# 2. Traefik has loaded the configurations
# 3. HTTP routing works to your apps

# Set colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}Verifying CloudLunacy Front Server Configuration${NC}"
echo "------------------------------------------------"

# Check if we should verify a specific agent/app
AGENT_ID=${1:-"test-agent"}
SUBDOMAIN=${2:-"myapp"}
APP_DOMAIN=${APP_DOMAIN:-"apps.cloudlunacy.uk"}

echo -e "\n${YELLOW}1. Checking Consul KV store for router entries:${NC}"
ROUTER_KEY="traefik/http/routers/${AGENT_ID}-${SUBDOMAIN}"
ROUTER_RESULT=$(docker exec consul consul kv get "$ROUTER_KEY" 2>/dev/null)
if [ -n "$ROUTER_RESULT" ]; then
    echo -e "${GREEN}✓ Router found in Consul KV store${NC}"
    echo -e "Router config:\n$ROUTER_RESULT"
else
    echo -e "${RED}✗ Router not found in Consul KV. Key: $ROUTER_KEY${NC}"
fi

echo -e "\n${YELLOW}2. Checking Consul KV store for service entries:${NC}"
SERVICE_KEY="traefik/http/services/${AGENT_ID}-${SUBDOMAIN}-service"
SERVICE_RESULT=$(docker exec consul consul kv get "$SERVICE_KEY" 2>/dev/null)
if [ -n "$SERVICE_RESULT" ]; then
    echo -e "${GREEN}✓ Service found in Consul KV store${NC}"
    echo -e "Service config:\n$SERVICE_RESULT"
else
    echo -e "${RED}✗ Service not found in Consul KV. Key: $SERVICE_KEY${NC}"
fi

echo -e "\n${YELLOW}3. Checking Traefik logs for configuration loading:${NC}"
LOAD_RESULT=$(docker logs traefik 2>&1 | grep -E "Consul provider: (Configuration received|loaded routers/services)" | tail -3)
if [ -n "$LOAD_RESULT" ]; then
    echo -e "${GREEN}✓ Traefik logs show Consul provider activity${NC}"
    echo -e "$LOAD_RESULT"
else
    echo -e "${RED}✗ No Consul provider loading activity found in Traefik logs${NC}"
    echo "Checking for related Consul logs..."
    docker logs traefik 2>&1 | grep -i consul | tail -5
fi

echo -e "\n${YELLOW}4. Testing HTTP routing to app:${NC}"
echo "Trying to connect to http://${SUBDOMAIN}.${APP_DOMAIN}"
HTTP_RESULT=$(curl -s -o /dev/null -w "%{http_code}" -v http://${SUBDOMAIN}.${APP_DOMAIN} 2>&1 | grep -E "< HTTP/|Connected to")

if [ -n "$HTTP_RESULT" ]; then
    echo -e "${GREEN}Connection attempt returned:${NC}"
    echo -e "$HTTP_RESULT"
else
    echo -e "${RED}✗ Failed to connect to http://${SUBDOMAIN}.${APP_DOMAIN}${NC}"
fi

echo -e "\n${YELLOW}5. Testing HTTPS routing to app:${NC}"
echo "Trying to connect to https://${SUBDOMAIN}.${APP_DOMAIN}"
HTTPS_RESULT=$(curl -s -o /dev/null -w "%{http_code}" -v -k https://${SUBDOMAIN}.${APP_DOMAIN} 2>&1 | grep -E "< HTTP/|Connected to|certificate ")

if [ -n "$HTTPS_RESULT" ]; then
    echo -e "${GREEN}Connection attempt returned:${NC}"
    echo -e "$HTTPS_RESULT"
else
    echo -e "${RED}✗ Failed to connect to https://${SUBDOMAIN}.${APP_DOMAIN}${NC}"
fi

echo -e "\n${YELLOW}Configuration verification complete.${NC}"
echo -e "If there were any errors, check the logs with: docker logs traefik | tail -50"
