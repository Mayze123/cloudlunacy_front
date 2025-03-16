#!/bin/bash
# Stop the development environment

echo "Stopping development environment..."
docker-compose -f docker-compose.dev.yml down

echo "Development environment stopped."
echo "To remove volumes, run: docker-compose -f docker-compose.dev.yml down -v" 