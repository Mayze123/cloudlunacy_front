#!/bin/bash
echo "Restarting Node.js services with certificate fix..."

# Stop and restart only the node-app service
docker-compose stop node-app
docker-compose rm -f node-app
docker-compose up -d node-app

echo "Node.js service restarted. Check logs for any errors:"
echo "docker-compose logs -f node-app" 