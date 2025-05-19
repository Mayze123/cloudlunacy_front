#!/bin/bash

# Script to restart node-app and test the app routing functionality
# Created as part of the app routing integration

echo "=== CloudLunacy App Routing Integration ==="
echo "Restarting node-app service to apply changes..."

# Change to the project root directory
cd "$(dirname "$0")/.."

# Restart the node-app service 
echo "Running restart-node-app.sh..."
./restart-node-app.sh

# Restart Traefik to apply config changes
echo "Restarting Traefik to apply configuration changes..."
docker-compose restart traefik

# Wait for the services to start
echo "Waiting for services to start..."
sleep 10

# Check if Traefik is running
echo "Checking if Traefik is running..."
docker-compose ps traefik
docker-compose logs --tail=20 traefik

# Check the node-app service
echo "Checking node-app status..."
docker-compose ps node-app
docker-compose logs --tail=20 node-app

# Test proxy-routes endpoint
echo "Testing /proxy/routes endpoint..."
curl -s "http://localhost:3005/proxy/routes" | jq .

# Test the app routing
echo "Testing app routing with test script..."
./scripts/test-app-routing.sh

echo "=== Integration completed ==="
