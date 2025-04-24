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

# Install dependencies with clean npm cache
RUN npm cache clean --force && \
    npm ci --production && \
    # Install specific versions of problematic packages if needed
    npm install mongodb@5.7.0 express@4.18.2 yaml@2.7.0 winston@3.17.0 --save

# Copy start.sh and start.js scripts
COPY start.sh /app/start.sh
COPY start.js /app/start.js 

# Copy the rest of the application
COPY . .

# Create necessary directories with proper permissions
RUN mkdir -p /app/scripts /app/config/certs /app/config/certs/agents /app/config/certs/private /app/logs && \
    # Ensure cert directories are writable by the node user
    chown -R node:node /app/config/certs /app/logs

# Make scripts executable
RUN find /app/scripts -type f -name "*.sh" -exec chmod +x {} \;
RUN chmod +x /app/start.sh

# Set environment variables
ENV NODE_ENV=production
ENV TZ=UTC
ENV NODE_DEBUG=

# Expose port
EXPOSE 3005

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget -qO- http://localhost:3005/health || exit 1

# Switch to non-root user
USER node

# Command to start the application
CMD ["/bin/sh", "/app/start.sh"]