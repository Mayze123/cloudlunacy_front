#!/bin/sh
# Entry point script for the Docker container

# Create necessary directories
mkdir -p /app/scripts /app/config /app/config/agents

# Create symlinks if needed
if [ -d "/node-app/scripts" ]; then
  ln -sf /node-app/scripts/* /app/scripts/ 2>/dev/null || true
  echo "Linked scripts from /node-app/scripts to /app/scripts"
fi

# Create symlinks for config directory
ln -sf /config /app/config 2>/dev/null || true
ln -sf /config /etc/traefik 2>/dev/null || true

# Set default environment variables if not provided
export NODE_PORT=${NODE_PORT:-3005}
export NODE_ENV=${NODE_ENV:-production}
export MONGO_DOMAIN=${MONGO_DOMAIN:-mongodb.cloudlunacy.uk}
export APP_DOMAIN=${APP_DOMAIN:-apps.cloudlunacy.uk}

# Run the startup validator
echo "Running startup validation..."
node /app/scripts/startup-validator.js

# Check if validation passed
if [ $? -ne 0 ]; then
  echo "Startup validation failed. Attempting to fix issues..."
  
  # Try to reinstall dependencies
  echo "Reinstalling dependencies..."
  npm ci
  
  # Run validation again
  node /app/scripts/startup-validator.js
  
  if [ $? -ne 0 ]; then
    echo "Failed to fix issues automatically. Please check the logs and fix manually."
    exit 1
  fi
fi

# Run the application with fallbacks
echo "Starting application..."
if [ -f "/app/start.js" ]; then
  echo "Found start.js, using it as entry point"
  exec node /app/start.js
elif [ -f "/opt/cloudlunacy_front/node-app/start.js" ]; then
  echo "Found start.js in /opt/cloudlunacy_front/node-app, using it"
  exec node /opt/cloudlunacy_front/node-app/start.js
elif [ -f "/app/server.js" ]; then
  echo "Found server.js, using it as entry point"
  exec node /app/server.js
else
  echo "ERROR: Could not find start.js or server.js"
  echo "Available files in /app:"
  ls -la /app
  exit 1
fi