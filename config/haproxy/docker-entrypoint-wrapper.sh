#!/bin/sh
set -e

echo "Starting HAProxy with wrapper..."

# Run the custom entrypoint script
exec /usr/local/bin/custom-entrypoint.sh "$@" 