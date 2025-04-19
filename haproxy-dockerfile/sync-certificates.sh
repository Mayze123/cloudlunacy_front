#!/bin/bash
# Certificate synchronization script for HAProxy
# Copies certificates from the Node.js application to HAProxy

# Logging function
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

log "Starting certificate synchronization..."

# Define paths
NODE_APP_CONTAINER="cloudlunacy-front"
HAPROXY_CONTAINER="haproxy"
CERTS_DIR="/etc/ssl/certs"
PRIVATE_DIR="/etc/ssl/private"
TEMP_DIR="/tmp/cert-sync"

# Create temp directory
mkdir -p $TEMP_DIR
if [ $? -ne 0 ]; then
  log "Error: Failed to create temporary directory"
  exit 1
fi

# Check if containers are running
if ! docker ps | grep -q $NODE_APP_CONTAINER; then
  log "Error: Node.js application container not running"
  exit 1
fi

if ! docker ps | grep -q $HAPROXY_CONTAINER; then
  log "Error: HAProxy container not running"
  exit 1
fi

# Sync CA certificates
log "Syncing CA certificates..."
docker exec $NODE_APP_CONTAINER sh -c "cat /app/certs/ca.crt" > $TEMP_DIR/ca.crt
if [ $? -eq 0 ]; then
  docker cp $TEMP_DIR/ca.crt $HAPROXY_CONTAINER:$CERTS_DIR/ca.crt
  docker exec $HAPROXY_CONTAINER sh -c "ln -sf $CERTS_DIR/ca.crt $CERTS_DIR/mongodb-ca.crt"
  docker exec $HAPROXY_CONTAINER sh -c "chmod 644 $CERTS_DIR/ca.crt $CERTS_DIR/mongodb-ca.crt"
  log "CA certificate synced successfully"
else
  log "Error: Failed to fetch CA certificate from Node.js container"
fi

# Sync CA key
log "Syncing CA key..."
docker exec $NODE_APP_CONTAINER sh -c "cat /app/certs/ca.key" > $TEMP_DIR/ca.key
if [ $? -eq 0 ]; then
  docker cp $TEMP_DIR/ca.key $HAPROXY_CONTAINER:$PRIVATE_DIR/ca.key
  docker exec $HAPROXY_CONTAINER sh -c "chmod 600 $PRIVATE_DIR/ca.key"
  log "CA key synced successfully"
else
  log "Error: Failed to fetch CA key from Node.js container"
fi

# Sync agent certificates
log "Syncing agent certificates..."
# List agent directories
AGENTS=$(docker exec $NODE_APP_CONTAINER sh -c "ls -1 /app/certs/agents")
if [ $? -ne 0 ]; then
  log "Error: Failed to list agent directories"
else
  # For each agent, sync certificates
  for AGENT_ID in $AGENTS; do
    log "Processing agent: $AGENT_ID"
    
    # Create combined PEM file for HAProxy
    docker exec $NODE_APP_CONTAINER sh -c "cat /app/certs/agents/$AGENT_ID/server.key /app/certs/agents/$AGENT_ID/server.crt" > $TEMP_DIR/$AGENT_ID.pem
    if [ $? -eq 0 ]; then
      docker cp $TEMP_DIR/$AGENT_ID.pem $HAPROXY_CONTAINER:$PRIVATE_DIR/$AGENT_ID.pem
      docker exec $HAPROXY_CONTAINER sh -c "chmod 600 $PRIVATE_DIR/$AGENT_ID.pem"
      log "Certificate for agent $AGENT_ID synced successfully"
    else
      log "Error: Failed to create combined PEM for agent $AGENT_ID"
    fi
  done
fi

# Verify certificates in HAProxy
log "Verifying certificates in HAProxy..."
CA_CERT_EXISTS=$(docker exec $HAPROXY_CONTAINER sh -c "test -f $CERTS_DIR/ca.crt && echo yes || echo no")
CA_KEY_EXISTS=$(docker exec $HAPROXY_CONTAINER sh -c "test -f $PRIVATE_DIR/ca.key && echo yes || echo no")
MONGODB_CA_EXISTS=$(docker exec $HAPROXY_CONTAINER sh -c "test -f $CERTS_DIR/mongodb-ca.crt && echo yes || echo no")

log "Verification results:"
log "- CA Certificate: $CA_CERT_EXISTS"
log "- CA Key: $CA_KEY_EXISTS"
log "- MongoDB CA: $MONGODB_CA_EXISTS"

# Clean up temp directory
rm -rf $TEMP_DIR
log "Certificate synchronization completed"
exit 0