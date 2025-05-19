#!/bin/bash
# Fix and restart the CloudLunacy Front app routing system

set -e

echo "Fixing App Routing Configuration"
echo "--------------------------------"

# Define colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

# Step 1: Run Node.js script to fix Consul configuration
echo -e "${YELLOW}Step 1: Running fix-app-routing.js to update Consul KV store${NC}"
node scripts/fix-app-routing.js

# Step 2: Make sure middleware file is properly set up
echo -e "\n${YELLOW}Step 2: Ensuring middleware configuration is correct${NC}"
cat > config/traefik/dynamic/middleware.yml << EOL
# Dynamic middleware configuration for Traefik
# This file is managed by CloudLunacy Front

http:
  middlewares:
    # Security headers middleware
    secure-headers:
      headers:
        frameDeny: true
        browserXssFilter: true
        contentTypeNosniff: true
        forceSTSHeader: true
        stsIncludeSubdomains: true
        stsPreload: true
        stsSeconds: 31536000

    # CORS headers middleware
    cors-headers:
      headers:
        accessControlAllowMethods:
          - GET
          - POST
          - PUT
          - DELETE
          - OPTIONS
        accessControlAllowHeaders:
          - Authorization
          - Content-Type
          - X-Requested-With
        accessControlAllowOriginList:
          - "*"
        accessControlMaxAge: 86400

    # Compress middleware
    compress:
      compress: {}

    # Redirect to HTTPS middleware
    redirect-to-https:
      redirectScheme:
        scheme: https
        permanent: true

    # Chain middleware for app routing
    app-routing:
      chain:
        middlewares:
          - secure-headers
          - cors-headers
          - compress

    # Basic auth middleware for dashboard
    auth-admin:
      basicAuth:
        users:
          - "admin:$apr1$zgc4evbu$C6hGVGs0ZmWFKQBDS3jfJ1" # Password: cloudlunacy
EOL
echo -e "${GREEN}✅ Updated middleware.yml${NC}"

# Step 3: Ensure routes.yml has the correct app router
echo -e "\n${YELLOW}Step 3: Ensuring routes.yml has the correct app router${NC}"

# Check if routes.yml exists and contains the apps router
if grep -q "apps:" config/traefik/dynamic/routes.yml; then
  echo -e "${GREEN}✅ routes.yml already contains apps router${NC}"
else
  echo "Adding apps router to routes.yml"
  # Backup the original file
  cp config/traefik/dynamic/routes.yml config/traefik/dynamic/routes.yml.bak
  
  # Insert the apps router configuration
  awk '
  /http:/ { print; print "  routers:"; next }
  /routers:/ { print; next }
  /# Dynamic app router - handles all app subdomains/ { found=1 }
  /apps:/ { found=1 }
  !found && /  services:/ { 
    print "    # Dynamic app router - handles all app subdomains";
    print "    apps:";
    print "      entryPoints:";
    print "        - \"websecure\"";
    print "      rule: \"HostRegexp(`{subdomain:[a-z0-9-]+}.apps.cloudlunacy.uk`)\"";
    print "      service: \"node-app-service\"";
    print "      middlewares:";
    print "        - app-routing";
    print "      tls:";
    print "        certResolver: \"letsencrypt\"";
    print "      priority: 100";
    print "";
    found=1;
  }
  { print }
  ' config/traefik/dynamic/routes.yml > config/traefik/dynamic/routes.yml.new
  
  mv config/traefik/dynamic/routes.yml.new config/traefik/dynamic/routes.yml
  echo -e "${GREEN}✅ Updated routes.yml with apps router${NC}"
fi

# Step 4: Restart containers to apply changes
echo -e "\n${YELLOW}Step 4: Restarting containers to apply changes${NC}"
docker-compose restart traefik node-app
echo -e "${GREEN}✅ Restarted traefik and node-app containers${NC}"

# Step 5: Signal Traefik to reload configuration
echo -e "\n${YELLOW}Step 5: Signaling Traefik to reload configuration${NC}"
docker exec $(docker ps -f name=cloudlunacy_front_traefik --format "{{.ID}}") kill -s HUP 1
echo -e "${GREEN}✅ Sent HUP signal to Traefik${NC}"

# Step 6: Update the node-app API
echo -e "\n${YELLOW}Step 6: Checking and fixing node-app API${NC}"
RESTART_NODE_APP=false

# Fix AppRegistrationService initialization in node-app/services/core/index.js
if grep -q "appRegistrationService = new AppRegistrationService()" node-app/services/core/index.js; then
  echo -e "${GREEN}✅ AppRegistrationService already initialized in core/index.js${NC}"
else
  echo "Fixing AppRegistrationService initialization in core/index.js"
  # Check if the file exists
  if [ -f "node-app/services/core/index.js" ]; then
    # Create a backup
    cp node-app/services/core/index.js node-app/services/core/index.js.bak
    
    # Update the file to add the AppRegistrationService
    sed -i '' '/const ProxyService/a\\
const AppRegistrationService = require("./appRegistrationService");
' node-app/services/core/index.js
    
    sed -i '' '/proxyService = new ProxyService()/a\\
// Initialize app registration service\\
const appRegistrationService = new AppRegistrationService();
' node-app/services/core/index.js
    
    sed -i '' '/module.exports = {/a\\
  appRegistrationService,
' node-app/services/core/index.js
    
    echo -e "${GREEN}✅ Added AppRegistrationService to core/index.js${NC}"
    RESTART_NODE_APP=true
  else
    echo -e "${RED}❌ Could not find core/index.js${NC}"
  fi
fi

if [ "$RESTART_NODE_APP" = true ]; then
  echo -e "\n${YELLOW}Step 7: Restarting node-app to apply code changes${NC}"
  docker-compose restart node-app
  echo -e "${GREEN}✅ Restarted node-app container${NC}"
fi

echo -e "\n${YELLOW}Step 8: Testing app routing${NC}"
echo "Waiting 5 seconds for services to be fully up..."
sleep 5
bash scripts/test-app-routing-detailed.sh

echo -e "\n${GREEN}All fixes have been applied!${NC}"
echo "If you're still experiencing issues, please check the Traefik logs:"
echo "docker logs \$(docker ps -f name=cloudlunacy_front_traefik --format \"{{.ID}}\")"
