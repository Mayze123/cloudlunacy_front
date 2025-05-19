#!/bin/bash
# Test App Routing and /proxy/routes

set -e

echo "Testing App Routing and /proxy/routes endpoint"
echo "------------------------------------------"

# Define colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

API_URL="http://localhost:3005"
PROXY_ROUTES_PATH="/api/proxy/routes"
APP_DOMAIN=${APP_DOMAIN:-"apps.cloudlunacy.uk"}

echo -e "${YELLOW}Step 1: Testing /proxy/routes endpoint${NC}"
echo "Making request to $API_URL$PROXY_ROUTES_PATH"

RESPONSE=$(curl -s -w "\n%{http_code}" "$API_URL$PROXY_ROUTES_PATH")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
RESPONSE_BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" -eq 200 ]; then
  echo -e "${GREEN}✅ /proxy/routes endpoint is accessible (HTTP 200)${NC}"
else
  echo -e "${RED}❌ /proxy/routes endpoint returned HTTP $HTTP_CODE${NC}"
  echo "Response body:"
  echo "$RESPONSE_BODY"
  echo "Continuing with tests..."
fi

# Check if response contains routes
if [[ "$RESPONSE_BODY" == *"\"routes\""* ]]; then
  echo -e "${GREEN}✅ Response contains 'routes' field${NC}"
  
  # Extract route count if possible
  if [[ "$RESPONSE_BODY" == *"\"routeCount\""* ]]; then
    ROUTE_COUNT=$(echo "$RESPONSE_BODY" | grep -o '"routeCount":[0-9]*' | grep -o '[0-9]*')
    echo -e "${GREEN}✅ Found $ROUTE_COUNT routes${NC}"
  fi
else
  echo -e "${RED}❌ Response doesn't contain 'routes' field${NC}"
fi

echo -e "\n${YELLOW}Step 2: Testing Consul KV store for app routing configuration${NC}"
echo "Checking Consul KV for app routes..."

# Check if docker and consul container are running
CONSUL_CONTAINER=$(docker ps --filter "name=cloudlunacy_front_consul" --format "{{.Names}}")

if [ -z "$CONSUL_CONTAINER" ]; then
  echo -e "${RED}❌ Consul container not found or not running${NC}"
  echo "Please ensure Consul is running before continuing."
  exit 1
fi

echo "Found Consul container: $CONSUL_CONTAINER"

# Check for app-routing middleware in Consul KV
echo "Checking for app-routing middleware..."
APP_ROUTING_MIDDLEWARE=$(docker exec $CONSUL_CONTAINER consul kv get traefik/http/middlewares/app-routing)

if [ $? -eq 0 ]; then
  echo -e "${GREEN}✅ app-routing middleware exists in Consul KV${NC}"
  echo "$APP_ROUTING_MIDDLEWARE"
else
  echo -e "${RED}❌ app-routing middleware not found in Consul KV${NC}"
fi

# Check for apps router in Consul KV
echo "Checking for apps router..."
APPS_ROUTER=$(docker exec $CONSUL_CONTAINER consul kv get traefik/http/routers/apps)

if [ $? -eq 0 ]; then
  echo -e "${GREEN}✅ apps router exists in Consul KV${NC}"
  echo "$APPS_ROUTER"
else
  echo -e "${RED}❌ apps router not found in Consul KV${NC}"
fi

# List all HTTP routers in Consul KV
echo "Listing all HTTP routers in Consul KV..."
HTTP_ROUTERS=$(docker exec $CONSUL_CONTAINER consul kv get -recurse traefik/http/routers/)

echo "HTTP Routers:"
echo "$HTTP_ROUTERS"

echo -e "\n${YELLOW}Step 3: Testing app subdomain resolution${NC}"
echo "Testing if a subdomain resolves correctly..."

# Generate a test subdomain
TEST_SUBDOMAIN="test-$(date +%s)"
echo "Using test subdomain: $TEST_SUBDOMAIN.$APP_DOMAIN"

# Register the test route
echo "Registering test route..."
REGISTER_RESPONSE=$(curl -s -X POST "$API_URL/api/frontdoor/add-app" \
  -H "Content-Type: application/json" \
  -d "{\"subdomain\":\"$TEST_SUBDOMAIN\",\"targetUrl\":\"http://node-app:3005\",\"agentId\":\"test\"}")

echo "Registration response: $REGISTER_RESPONSE"

echo -e "\n${YELLOW}Summary${NC}"
echo "-------------------"
echo "1. /proxy/routes endpoint test: $([ "$HTTP_CODE" -eq 200 ] && echo -e "${GREEN}PASSED${NC}" || echo -e "${RED}FAILED${NC}")"
echo "2. Consul KV configuration: $([ ! -z "$APP_ROUTING_MIDDLEWARE" ] && [ ! -z "$APPS_ROUTER" ] && echo -e "${GREEN}PASSED${NC}" || echo -e "${RED}FAILED${NC}")"
echo "3. App registration: $(echo "$REGISTER_RESPONSE" | grep -q "success" && echo -e "${GREEN}PASSED${NC}" || echo -e "${RED}FAILED${NC}")"

echo -e "\n${YELLOW}Next Steps:${NC}"
echo "1. If you're experiencing 404 errors, run the fix-app-routing.js script:"
echo "   node scripts/fix-app-routing.js"
echo "2. Reload Traefik configuration from Consul:"
echo "   docker exec \$(docker ps -f name=traefik --format \"{{.ID}}\") kill -s HUP 1"
echo "3. Check Traefik logs for any errors:"
echo "   docker logs \$(docker ps -f name=traefik --format \"{{.ID}}\") | tail -n 50"
