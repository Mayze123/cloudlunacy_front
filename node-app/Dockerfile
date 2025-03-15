FROM node:18-alpine

WORKDIR /app

# Install necessary tools
RUN apk add --no-cache \
    curl \
    bash \
    wget \
    openssl \
    jq \
    docker-cli \
    ca-certificates \
    tzdata

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy start.sh and start.js scripts
COPY start.sh /app/start.sh
COPY start.js /app/start.js 

# Copy the rest of the application
COPY . .

# Create necessary directories
RUN mkdir -p /app/scripts /app/config/certs /app/config/certs/agents /app/logs

# Make scripts executable
RUN find /app/scripts -type f -name "*.sh" -exec chmod +x {} \;
RUN chmod +x /app/start.sh

# Set environment variables
ENV NODE_ENV=production
ENV TZ=UTC

# Expose port
EXPOSE 3005

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget -qO- http://localhost:3005/health || exit 1

# Command to start the application
CMD ["/bin/sh", "/app/start.sh"]