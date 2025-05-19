#!/bin/bash

# apply-traefik-fixes.sh
# Script to apply the reliability fixes to Traefik and Consul integration

# Set colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}Applying Traefik and Consul reliability fixes${NC}"
echo "------------------------------------------------"

# 1. Check if we're in the correct directory
if [ ! -f "./config/traefik/traefik.yml" ]; then
    echo -e "${RED}Error: This script must be run from the CloudLunacy Front Server root directory${NC}"
    exit 1
fi

# 2. Backup current configuration
echo -e "\n${YELLOW}Creating backups of configuration files...${NC}"
BACKUP_DIR="./config/traefik/backup-$(date +%Y%m%d%H%M%S)"
mkdir -p "$BACKUP_DIR"

cp ./config/traefik/traefik.yml "$BACKUP_DIR/traefik.yml.bak"
echo -e "${GREEN}✓ Configuration backup created in $BACKUP_DIR${NC}"

# 3. Restart needed services
echo -e "\n${YELLOW}Restarting services to apply changes...${NC}"

# Check if docker-compose is installed
if ! command -v docker-compose &> /dev/null; then
    echo -e "${YELLOW}Using docker compose command (newer format)${NC}"
    DOCKER_COMPOSE="docker compose"
else
    DOCKER_COMPOSE="docker-compose"
fi

$DOCKER_COMPOSE restart traefik
echo -e "${GREEN}✓ Traefik restarted${NC}"

# 4. Verify the change by checking if Consul watch is enabled
echo -e "\n${YELLOW}Verifying Traefik configuration...${NC}"
WATCH_ENABLED=$(grep -A 3 "consul:" ./config/traefik/traefik.yml | grep "watch: true")
if [ -n "$WATCH_ENABLED" ]; then
    echo -e "${GREEN}✓ Consul watch is properly enabled${NC}"
else
    echo -e "${RED}✗ Consul watch setting not found in traefik.yml${NC}"
fi

# 5. Check if wildcard for apps domain is properly added
WILDCARD_CONFIG=$(grep -A 10 "certResolver: letsencrypt" ./config/traefik/traefik.yml | grep "*.apps")
if [ -n "$WILDCARD_CONFIG" ]; then
    echo -e "${GREEN}✓ Wildcard domain for apps is configured${NC}"
else
    echo -e "${RED}✗ Wildcard domain for apps not found in ACME configuration${NC}"
fi

# 6. Check if Traefik logs show the Consul provider loading
echo -e "\n${YELLOW}Checking Traefik logs for Consul provider activity...${NC}"
sleep 5  # Give Traefik a moment to initialize
CONSUL_LOADED=$(docker logs traefik 2>&1 | grep -E "Consul provider: (Configuration received|loaded)" | tail -3)
if [ -n "$CONSUL_LOADED" ]; then
    echo -e "${GREEN}✓ Traefik logs show Consul provider activity:${NC}"
    echo "$CONSUL_LOADED"
else
    echo -e "${RED}✗ No Consul provider activity found in logs${NC}"
    echo "Check the logs manually for more details:"
    echo "docker logs traefik | grep -i consul"
fi

echo -e "\n${YELLOW}Running verification script...${NC}"
./scripts/verify-app-config.sh

echo -e "\n${GREEN}Traefik and Consul reliability fixes have been applied!${NC}"
echo -e "To restore HTTP to HTTPS redirects after testing, uncomment the relevant section in config/traefik/traefik.yml"
echo -e "See docs/TRAEFIK_RELIABILITY_UPDATES.md for more details"
