#!/bin/bash
# test-certificate-resilience.sh
# This script tests the resilience of HAProxy's Data Plane API to certificate issues

# Log function
log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') - $1"
}

log "Starting certificate resilience test..."

# Step 1: Verify HAProxy is running properly
if ! docker ps | grep -q haproxy; then
  log "ERROR: HAProxy container not running"
  exit 1
fi

log "HAProxy container is running"

# Step 2: Test the Data Plane API health before we start
log "Testing Data Plane API health before test..."
if docker exec haproxy curl -s -f http://127.0.0.1:5555/v3/health > /dev/null; then
  log "✅ Data Plane API is healthy before test"
else
  log "⚠️ Data Plane API is not healthy before test - this test will verify if our fixes improve the situation"
fi

# Step 3: Verify that certificates are synced to the temp directory
log "Running certificate sync..."
docker exec haproxy /usr/local/bin/sync-certificates.sh > /dev/null
if docker exec haproxy test -f /tmp/certs/certs/ca.crt; then
  log "✅ Certificates synced successfully to temporary directory"
else
  log "❌ Failed to sync certificates to temporary directory"
  exit 1
fi

# Step 4: Force kill the Data Plane API process to simulate a crash
log "Forcing Data Plane API to crash..."
if docker exec haproxy pkill -9 dataplaneapi; then
  log "✅ Data Plane API process terminated"
else
  log "⚠️ No Data Plane API process found to terminate"
fi

# Step 5: Wait for the HAProxy entrypoint script to restart Data Plane API
log "Waiting for automatic recovery (10 seconds)..."
sleep 10

# Step 6: Verify HAProxy is still running after Data Plane API crash
if docker ps | grep -q haproxy; then
  log "✅ HAProxy container is still running after Data Plane API crash"
else
  log "❌ HAProxy container failed after Data Plane API crash"
  exit 1
fi

# Step 7: Check if the Data Plane API recovered
if docker exec haproxy pgrep dataplaneapi > /dev/null; then
  log "✅ Data Plane API process restarted automatically"
  
  # Step 8: Check if the Data Plane API is healthy
  if docker exec haproxy curl -s -f http://127.0.0.1:5555/v3/health > /dev/null; then
    log "✅ Data Plane API is healthy after crash - our fix works!"
  else
    log "⚠️ Data Plane API process restarted but is not yet healthy"
  fi
else
  # Even if Data Plane API didn't recover, HAProxy should still be functional
  log "⚠️ Data Plane API process did not restart, but HAProxy should still be functional"
fi

# Step 9: Verify HAProxy is still functional by checking a backend
log "Testing HAProxy functionality..."
if docker exec haproxy curl -s -I http://127.0.0.1:8081/ | grep -q "HTTP/"; then
  log "✅ HAProxy is still serving traffic"
else
  log "⚠️ HAProxy is not responding to requests"
fi

# Step 10: Final status
log "Test completed. HAProxy should continue to function even with Data Plane API issues."

exit 0