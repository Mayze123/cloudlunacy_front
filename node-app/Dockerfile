FROM node:18-alpine

WORKDIR /app

# Install necessary tools
RUN apk add --no-cache curl bash wget

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
RUN mkdir -p /app/scripts /app/config

# Make the startup script executable
RUN chmod +x /app/start.sh

# Set environment variables
ENV NODE_ENV=production

# Expose port
EXPOSE 3005

# Command to start the application
CMD ["/bin/sh", "/app/start.sh"]