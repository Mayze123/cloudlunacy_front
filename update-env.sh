#!/bin/bash
# This script ensures that environment variables are properly set

# Navigate to the project directory
cd "$(dirname "$0")"

# Load .env file if it exists
if [ -f .env ]; then
  echo "Loading environment variables from .env file..."
  export $(grep -v '^#' .env | xargs)
else
  echo "No .env file found. Creating one..."
  cat > .env << EOL
CF_EMAIL=${CF_EMAIL:-your_cloudflare_email}
CF_API_KEY=${CF_API_KEY:-your_cloudflare_api_key}
NODE_PORT=${NODE_PORT:-3005}
JWT_SECRET=${JWT_SECRET:-$(openssl rand -base64 32)}
APP_DOMAIN=apps.cloudlunacy.uk
MONGO_DOMAIN=mongodb.cloudlunacy.uk
EOL
  echo ".env file created with default values. Please edit it with your actual information."
  
  # Load the newly created file
  export $(grep -v '^#' .env | xargs)
fi

# Verify required variables
echo "Verifying environment variables..."
if [ -z "$APP_DOMAIN" ]; then
  echo "APP_DOMAIN is not set, using default: apps.cloudlunacy.uk"
  echo "APP_DOMAIN=apps.cloudlunacy.uk" >> .env
  export APP_DOMAIN=apps.cloudlunacy.uk
fi

if [ -z "$MONGO_DOMAIN" ]; then
  echo "MONGO_DOMAIN is not set, using default: mongodb.cloudlunacy.uk"
  echo "MONGO_DOMAIN=mongodb.cloudlunacy.uk" >> .env
  export MONGO_DOMAIN=mongodb.cloudlunacy.uk
fi

if [ -z "$JWT_SECRET" ]; then
  JWT_SECRET=$(openssl rand -base64 32)
  echo "JWT_SECRET is not set, generating a new one"
  echo "JWT_SECRET=$JWT_SECRET" >> .env
  export JWT_SECRET=$JWT_SECRET
fi

# Display current configuration
echo "Environment Configuration:"
echo "- APP_DOMAIN: $APP_DOMAIN"
echo "- MONGO_DOMAIN: $MONGO_DOMAIN"
echo "- NODE_PORT: $NODE_PORT"
echo "- JWT_SECRET: ${JWT_SECRET:0:5}... (hidden)"

# Ask if user wants to restart services
read -p "Do you want to restart services to apply these changes? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  echo "Restarting services..."
  docker-compose down
  docker-compose up -d
  echo "Services restarted."
else
  echo "Changes saved. Remember to restart services manually with 'docker-compose down && docker-compose up -d'"
fi

echo "Environment setup complete."