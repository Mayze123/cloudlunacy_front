#!/bin/bash
# This script runs all the necessary steps to fix and test your setup

cd "$(dirname "$0")"
echo "Starting setup process..."

# Run update-env.sh
echo "Step 1: Updating environment variables..."
./update-env.sh

# Restart services
echo "Step 2: Restarting services..."
docker-compose down
docker-compose up -d

# Wait for services to start
echo "Step 3: Waiting for services to start (30 seconds)..."
sleep 30

# Check service status
echo "Step 4: Checking service status..."
docker ps

# Check logs
echo "Step 5: Checking Traefik logs..."
docker logs traefik

echo "Step 6: Checking node-app logs..."
docker logs node-app

# Run test
echo "Step 7: Running test to verify Traefik setup..."
./test-traefik.sh

echo "Setup complete! Try accessing these URLs:"
echo "- Traefik Dashboard: http://$(hostname -I | awk '{print $1}'):8080/dashboard/"
echo "- Test Site: http://test.apps.cloudlunacy.uk"
echo "- Your App: http://cloudlunacy-server-production.apps.cloudlunacy.uk"