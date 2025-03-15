#!/bin/bash
# Fix dependencies script

echo "Fixing dependencies..."

# Navigate to the app directory
cd /app || exit 1

# Clean npm cache
echo "Cleaning npm cache..."
npm cache clean --force

# Remove node_modules
echo "Removing node_modules..."
rm -rf node_modules

# Install dependencies
echo "Installing dependencies..."
npm install

# Check for specific dependencies
echo "Checking for required dependencies..."
for dep in mongodb express yaml winston axios dotenv; do
  if ! npm list $dep >/dev/null 2>&1; then
    echo "Installing missing dependency: $dep"
    npm install $dep --save
  else
    echo "✓ $dep is installed"
  fi
done

echo "Dependencies fixed!" 