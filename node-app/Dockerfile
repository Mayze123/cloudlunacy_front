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
RUN echo '#!/bin/sh\n\
# Entry point script for the Docker container\n\
\n\
# Create necessary directories\n\
mkdir -p /app/scripts /app/config /app/config/agents\n\
\n\
# Create symlinks if needed\n\
if [ -d "/node-app/scripts" ]; then\n\
  ln -sf /node-app/scripts/* /app/scripts/ 2>/dev/null || true\n\
  echo "Linked scripts from /node-app/scripts to /app/scripts"\n\
fi\n\
\n\
# Create symlinks for config directory\n\
ln -sf /config /app/config 2>/dev/null || true\n\
ln -sf /config /etc/traefik 2>/dev/null || true\n\
\n\
# Check if we have a startup validator script\n\
if [ -f "/app/scripts/startup-validator.js" ]; then\n\
  echo "Running startup validator"\n\
  node /app/scripts/startup-validator.js || true\n\
elif [ -f "/node-app/scripts/startup-validator.js" ]; then\n\
  echo "Running startup validator from /node-app/scripts"\n\
  node /node-app/scripts/startup-validator.js || true\n\
fi\n\
\n\
# Check which main script to run\n\
if [ -f "/app/start.js" ]; then\n\
  echo "Found start.js, using it as entry point"\n\
  exec node /app/start.js\n\
elif [ -f "/node-app/start.js" ]; then\n\
  echo "Found start.js in /node-app, using it"\n\
  exec node /node-app/start.js\n\
elif [ -f "/app/frontdoorService.js" ]; then\n\
  echo "No start.js found, falling back to frontdoorService.js"\n\
  exec node /app/frontdoorService.js\n\
else\n\
  echo "ERROR: Could not find start.js or frontdoorService.js"\n\
  echo "Available files in /app:"\n\
  ls -la /app\n\
  exit 1\n\
fi' > /app/start.sh

# Make the startup script executable
RUN chmod +x /app/start.sh

# Set environment variables
ENV NODE_ENV=production

# Expose port
EXPOSE 3005

# Command to start the application
CMD ["/bin/sh", "/app/start.sh"]