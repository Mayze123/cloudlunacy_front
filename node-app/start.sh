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

# Check if start.js exists
if [ -f "/app/start.js" ]; then
  echo "Found start.js, using it as entry point"
  exec node /app/start.js
elif [ -f "/opt/cloudlunacy_front/node-app/start.js" ]; then
  echo "Found start.js in /opt/cloudlunacy_front/node-app, using it"
  exec node /opt/cloudlunacy_front/node-app/start.js
elif [ -f "/app/frontdoorService.js" ]; then
  echo "No start.js found, falling back to frontdoorService.js"
  
  # First try to run startup-validator.js if it exists
  if [ -f "/app/scripts/startup-validator.js" ]; then
    echo "Running startup validator first"
    node /app/scripts/startup-validator.js || true
  fi
  
  # Then start the main service
  exec node /app/frontdoorService.js
else
  echo "ERROR: Could not find start.js or frontdoorService.js"
  echo "Available files in /app:"
  ls -la /app
  exit 1
fi