#!/bin/sh
set -e

echo "Starting HAProxy Data Plane API service..."

# Start Data Plane API in the background
/usr/local/bin/start-dataplaneapi.sh &
DATAPLANEAPI_PID=$!

# Give a moment for Data Plane API to start initializing
sleep 2

echo "Running HAProxy with standard entrypoint..."
# Run the original HAProxy entrypoint with all arguments
exec docker-entrypoint.sh "$@" 