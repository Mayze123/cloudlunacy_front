#!/bin/sh
set -e

# Start Data Plane API in the background
/usr/local/bin/start-dataplaneapi.sh &

# Run the original HAProxy entrypoint with all arguments
exec docker-entrypoint.sh "$@" 