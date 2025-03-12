FROM node:18-alpine

WORKDIR /app

# Install necessary tools
RUN apk add --no-cache curl bash wget

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy the rest of the application
COPY . .

# Create necessary directories
RUN mkdir -p /app/scripts /app/config

# Create the start.sh script that will be used as the entry point
RUN echo '#!/bin/sh
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

# Check if we have a startup validator script
if [ -f "/app/scripts/startup-validator.js" ]; then
  echo "Running startup validator"
  node /app/scripts/startup-validator.js || true
elif [ -f "/node-app/scripts/startup-validator.js" ]; then
  echo "Running startup validator from /node-app/scripts"
  node /node-app/scripts/startup-validator.js || true
fi

# Check which main script to run
if [ -f "/app/start.js" ]; then
  echo "Found start.js, using it as entry point"
  exec node /app/start.js
elif [ -f "/node-app/start.js" ]; then
  echo "Found start.js in /node-app, using it"
  exec node /node-app/start.js
elif [ -f "/app/frontdoorService.js" ]; then
  echo "No start.js found, falling back to frontdoorService.js"
  exec node /app/frontdoorService.js
else
  echo "ERROR: Could not find start.js or frontdoorService.js"
  echo "Available files in /app:"
  ls -la /app
  exit 1
fi' > /app/start.sh

# Make the startup script executable
RUN chmod +x /app/start.sh

# Copy your existing start.js to ensure it's available
COPY start.js /app/start.js

# Set environment variables
ENV NODE_ENV=production

# Expose port
EXPOSE 3005

# Command to start the application
CMD ["/bin/sh", "/app/start.sh"]