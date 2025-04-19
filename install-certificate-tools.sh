#!/bin/bash
# install-certificate-tools.sh
# This script installs the certificate management tools in the HAProxy container
# and makes the installation persistent across restarts and code updates

# Log function
log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') - $1"
}

log "Installing certificate management tools..."

# Copy certificate pre-check script to HAProxy container
log "Copying certificate-precheck.sh to HAProxy container..."
if docker ps | grep -q haproxy; then
  docker cp ./config/haproxy/certificate-precheck.sh haproxy:/usr/local/etc/haproxy/certificate-precheck.sh
  docker exec haproxy chmod +x /usr/local/etc/haproxy/certificate-precheck.sh
  log "certificate-precheck.sh installed successfully"
else
  log "ERROR: HAProxy container not running"
fi

# Copy certificate synchronization script to HAProxy container
log "Copying sync-certificates.sh to HAProxy container..."
if docker ps | grep -q haproxy; then
  docker cp ./haproxy-dockerfile/sync-certificates.sh haproxy:/usr/local/bin/sync-certificates.sh
  docker exec haproxy chmod +x /usr/local/bin/sync-certificates.sh
  log "sync-certificates.sh installed successfully"
else
  log "ERROR: HAProxy container not running"
fi

# Create certificate directory structure if needed
log "Setting up certificate directory structure..."
if docker ps | grep -q haproxy; then
  docker exec haproxy mkdir -p /etc/ssl/certs
  docker exec haproxy mkdir -p /etc/ssl/private
  docker exec haproxy mkdir -p /tmp/certs/certs
  docker exec haproxy mkdir -p /tmp/certs/private
  docker exec haproxy mkdir -p /tmp/certs/agents
  
  # Don't try to change permissions on read-only filesystems
  docker exec haproxy bash -c "if touch /etc/ssl/certs/test_write 2>/dev/null; then chmod 755 /etc/ssl/certs; rm /etc/ssl/certs/test_write; fi"
  docker exec haproxy bash -c "if touch /etc/ssl/private/test_write 2>/dev/null; then chmod 700 /etc/ssl/private; rm /etc/ssl/private/test_write; fi"
  
  # Always set permissions on the temp directories
  docker exec haproxy chmod 755 /tmp/certs/certs
  docker exec haproxy chmod 700 /tmp/certs/private
  log "Certificate directories set up successfully"
else
  log "ERROR: HAProxy container not running"
fi

# Run the certificate pre-check script
log "Running certificate pre-check..."
if docker ps | grep -q haproxy; then
  docker exec haproxy /usr/local/etc/haproxy/certificate-precheck.sh
  log "Certificate pre-check completed"
else
  log "ERROR: HAProxy container not running"
fi

# Run the certificate sync script
log "Syncing certificates..."
if docker ps | grep -q haproxy; then
  docker exec haproxy /usr/local/bin/sync-certificates.sh
  log "Certificate sync completed"
else
  log "ERROR: HAProxy container not running"
fi

# Create a systemd service to make this persistent
log "Setting up persistence..."

# Create systemd service file
SYSTEMD_FILE="/etc/systemd/system/cert-tools-installer.service"
if [ -d "/etc/systemd/system" ]; then
  cat > $SYSTEMD_FILE << EOF
[Unit]
Description=Install Certificate Tools for HAProxy
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=$(pwd)/install-certificate-tools.sh
RemainAfterExit=true
WorkingDirectory=$(pwd)

[Install]
WantedBy=multi-user.target
EOF

  # Create systemd path watcher to trigger when HAProxy starts
  SYSTEMD_PATH_FILE="/etc/systemd/system/cert-tools-installer.path"
  cat > $SYSTEMD_PATH_FILE << EOF
[Unit]
Description=Watch for HAProxy container start

[Path]
PathExists=/var/run/docker/containerd/daemon/io.containerd.runtime.v2.task/moby/*/rootfs/var/run/haproxy.pid
Unit=cert-tools-installer.service

[Install]
WantedBy=multi-user.target
EOF

  log "Created systemd service files"
  
  # Reload systemd
  systemctl daemon-reload
  
  # Enable and start the services
  systemctl enable cert-tools-installer.service
  systemctl enable cert-tools-installer.path
  systemctl start cert-tools-installer.path
  
  log "Systemd service enabled - certificate tools will be automatically installed when HAProxy starts"
else
  # For non-systemd systems (like macOS), create a Docker restart hook
  log "Systemd not found, setting up Docker hook instead"
  
  # Create a Docker event handler script
  DOCKER_HOOK_SCRIPT="$(pwd)/docker-cert-hook.sh"
  cat > $DOCKER_HOOK_SCRIPT << EOF
#!/bin/bash
# Docker event handler for HAProxy certificate tools

HAPROXY_CONTAINER="haproxy"
SCRIPT_DIR="$(pwd)"

# Watch Docker events for HAProxy container starts
docker events --filter 'type=container' --filter "container=$HAPROXY_CONTAINER" --filter 'event=start' | while read event; do
  echo "HAProxy container started, installing certificate tools..."
  $SCRIPT_DIR/install-certificate-tools.sh
done
EOF

  chmod +x $DOCKER_HOOK_SCRIPT
  
  # Create a script to start the hook in the background
  START_HOOK_SCRIPT="$(pwd)/start-cert-hook.sh"
  cat > $START_HOOK_SCRIPT << EOF
#!/bin/bash
nohup $(pwd)/docker-cert-hook.sh > /tmp/docker-cert-hook.log 2>&1 &
echo \$! > /tmp/docker-cert-hook.pid
EOF

  chmod +x $START_HOOK_SCRIPT
  
  # Add to startup using crontab
  CRON_ENTRY="@reboot $(pwd)/start-cert-hook.sh"
  (crontab -l 2>/dev/null | grep -v "start-cert-hook.sh"; echo "$CRON_ENTRY") | crontab -
  
  # Start the hook now
  $START_HOOK_SCRIPT
  
  log "Docker hook script created and started - certificate tools will be automatically installed when HAProxy starts"
fi

# Also modify docker-compose.yml to ensure sync-certificates.sh is correctly copied to the container
if [ -f "./docker-compose.yml" ]; then
  log "Checking for volume mounts in docker-compose.yml..."
  
  # Check if we need to add the sync-certificates.sh volume mount
  if ! grep -q "./haproxy-dockerfile/sync-certificates.sh:/usr/local/bin/sync-certificates.sh" docker-compose.yml; then
    log "Adding sync-certificates.sh mount to docker-compose.yml is recommended"
    log "Add this line to the haproxy service volumes in docker-compose.yml:"
    log "  - ./haproxy-dockerfile/sync-certificates.sh:/usr/local/bin/sync-certificates.sh:ro"
  else
    log "sync-certificates.sh is already properly mounted in docker-compose.yml"
  fi
fi

log "Certificate management tools installation complete and persistence configured"