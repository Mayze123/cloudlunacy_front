#!/bin/bash
echo "Restarting HAProxy and Node.js services with fixed credentials..."

# Stop and restart services
docker-compose stop haproxy node-app
docker-compose rm -f haproxy node-app
docker-compose up -d haproxy
sleep 5
docker-compose up -d node-app

echo "Services restarted. Check logs for any errors:"
echo "For HAProxy: docker-compose logs -f haproxy"
echo "For Node.js: docker-compose logs -f node-app" 