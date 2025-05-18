#!/bin/bash

# Test App Routing Script
# This script tests the app routing functionality for CloudLunacy Front
# Updated to work with the new AppRegistrationService

echo "=== CloudLunacy App Routing Test ==="
echo "Testing app routes configuration..."

# Configuration
APP_DOMAIN="${APP_DOMAIN:-apps.cloudlunacy.uk}"
API_DOMAIN="${API_DOMAIN:-api.cloudlunacy.uk}"
API_PORT="${API_PORT:-3005}"  # Default node-app port

# Test sample app existence via curl
echo -e "\nTesting API endpoint availability..."
curl -s -I "https://$API_DOMAIN/health" | head -n1 || echo "API endpoint not available. Check if the server is running."

# Test app registration via API
echo -e "\nRegistering a test app..."
TEST_APP_NAME="testapp-$(date +%s | cut -c 8-10)"
TEST_TARGET="http://127.0.0.1:3005"  # Using node-app service as a test target

# Construct the registration request
echo "Registering app: $TEST_APP_NAME with target: $TEST_TARGET"
RESPONSE=$(curl -s -X POST "http://localhost:3005/api/frontdoor/add-app" \
  -H "Content-Type: application/json" \
  -d "{\"subdomain\": \"$TEST_APP_NAME\", \"targetUrl\": \"$TEST_TARGET\", \"agentId\": \"test-agent\"}")

echo "Registration response: $RESPONSE"

# Test app accessibility
sleep 2
echo -e "\nTesting app accessibility..."
echo "Trying to access: https://$TEST_APP_NAME.$APP_DOMAIN"
curl -s -I "https://$TEST_APP_NAME.$APP_DOMAIN" | head -n1 || echo "App not accessible. Check Traefik configuration."

# List registered apps
echo -e "\nListing all registered apps..."
curl -s "http://localhost:3005/api/app" | jq .

# Clean up - remove the test app
echo -e "\nCleaning up - removing test app..."
curl -s -X DELETE "http://localhost:3005/api/app/test-agent/$TEST_APP_NAME"

echo -e "\n=== Test completed ==="
