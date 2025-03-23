#!/bin/bash
# Reset the development environment

echo "Stopping and removing all development containers..."
docker-compose -f docker-compose.dev.yml down -v

echo "Removing Docker networks..."
docker network rm haproxy-network cloudlunacy-network 2>/dev/null || true

echo "Cleaning up Docker volumes..."
docker volume rm cloudlunacy_front_mongodb-data 2>/dev/null || true

echo "Recreating necessary directories..."
rm -rf config/agents logs config/haproxy/certs
mkdir -p config/agents logs config/haproxy/certs

echo "Development environment has been reset."
echo "Run ./start-dev.sh to start a fresh environment." 