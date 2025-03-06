#!/bin/bash
#
# CloudLunacy Traefik Protection Script
# This script ensures Traefik is running and protects it during deployments
# Place in /opt/cloudlunacy_front/ and run as a systemd service

set -e

FRONT_DIR="/opt/cloudlunacy_front"
LOG_FILE="/var/log/cloudlunacy-traefik-protection.log"
CHECK_INTERVAL=30 # seconds

# Ensure log file exists
touch "$LOG_FILE"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

restart_traefik() {
  log "Restarting Traefik..."
  cd "$FRONT_DIR"
  
  # First try to restart just Traefik
  if docker-compose restart traefik; then
    log "Successfully restarted Traefik container"
  else
    # If that fails, try to restart the whole stack
    log "Failed to restart just Traefik, restarting entire stack..."
    if docker-compose up -d; then
      log "Successfully restarted entire stack"
    else
      log "ERROR: Failed to restart stack!"
    fi
  fi
}

fix_dynamic_config() {
  log "Fixing dynamic configuration..."
  DYNAMIC_CONFIG="$FRONT_DIR/config/dynamic.yml"
  
  # Backup current config if it exists
  if [ -f "$DYNAMIC_CONFIG" ]; then
    cp "$DYNAMIC_CONFIG" "${DYNAMIC_CONFIG}.backup.$(date +%s)"
  fi
  
  # Create a properly structured config file
  cat > "$DYNAMIC_CONFIG" << EOF
# Traefik dynamic configuration
http:
  routers:
  services:
tcp:
  routers:
  services:
EOF
  
  log "Created new clean dynamic.yml with proper structure"
  
  # Try to recover routes from existing docker containers
  log "Attempting to auto-discover and restore routes..."
  
  # Look for containers with Traefik labels
  CONTAINERS=$(docker ps --format '{{.Names}}' --filter "label=traefik.enable=true" 2>/dev/null || echo "")
  
  if [ -n "$CONTAINERS" ]; then
    for CONTAINER in $CONTAINERS; do
      HOST_RULE=$(docker inspect --format '{{range $k,$v := .Config.Labels}}{{if eq $k "traefik.http.routers.*.rule"}}{{$v}}{{end}}{{end}}' "$CONTAINER" 2>/dev/null)
      SERVICE_PORT=$(docker inspect --format '{{range $k,$v := .Config.Labels}}{{if eq $k "traefik.http.services.*.loadbalancer.server.port"}}{{$v}}{{end}}{{end}}' "$CONTAINER" 2>/dev/null)
      
      if [ -n "$HOST_RULE" ] && [ -n "$SERVICE_PORT" ]; then
        CONTAINER_IP=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$CONTAINER" 2>/dev/null)
        
        if [ -n "$CONTAINER_IP" ]; then
          log "Found container $CONTAINER with host rule $HOST_RULE and port $SERVICE_PORT"
          # Extract domain from host rule
          DOMAIN=$(echo "$HOST_RULE" | sed -n 's/.*Host(`\(.*\)`).*$/\1/p')
          SERVICE_NAME="${CONTAINER}-service"
          ROUTER_NAME="${CONTAINER}"
          
          # Add to dynamic config
          TMP_CONFIG=$(mktemp)
          cat "$DYNAMIC_CONFIG" > "$TMP_CONFIG"
          
          # Use yq if available, otherwise use sed
          if command -v yq &> /dev/null; then
            yq -y ".http.routers.\"$ROUTER_NAME\" = {\"rule\": \"$HOST_RULE\", \"service\": \"$SERVICE_NAME\", \"entryPoints\": [\"web\", \"websecure\"], \"tls\": {\"certResolver\": \"letsencrypt\"}}" "$TMP_CONFIG" > "$DYNAMIC_CONFIG"
            yq -y ".http.services.\"$SERVICE_NAME\".loadBalancer.servers[0].url = \"http://$CONTAINER_IP:$SERVICE_PORT\"" "$DYNAMIC_CONFIG" > "$TMP_CONFIG"
            mv "$TMP_CONFIG" "$DYNAMIC_CONFIG"
          else
            # Simple sed-based approach (less robust)
            # This is a simplified version - in production you'd want better YAML handling
            sed -i "/http:\\s*router/a\\  routers:\\n    $ROUTER_NAME:\\n      rule: $HOST_RULE\\n      service: $SERVICE_NAME\\n      entryPoints:\\n        - web\\n        - websecure\\n      tls:\\n        certResolver: letsencrypt" "$DYNAMIC_CONFIG"
            sed -i "/http:\\s*services/a\\  services:\\n    $SERVICE_NAME:\\n      loadBalancer:\\n        servers:\\n          - url: http://$CONTAINER_IP:$SERVICE_PORT" "$DYNAMIC_CONFIG"
          fi
          
          log "Added route for $DOMAIN to $CONTAINER_IP:$SERVICE_PORT"
        fi
      fi
    done
  else
    log "No Traefik-enabled containers found to restore routes from"
  fi
}

check_traefik() {
  log "Checking Traefik status..."
  
  # Check if Traefik container exists and is running
  if ! docker ps | grep -q traefik; then
    log "Traefik container not running!"
    
    # Check if container exists but is stopped
    if docker ps -a | grep -q traefik; then
      log "Traefik container exists but is stopped"
      fix_dynamic_config
    else
      log "Traefik container doesn't exist at all"
    fi
    
    restart_traefik
    return
  fi
  
  # Check if Traefik is responding
  if ! curl -s -o /dev/null -w "%{http_code}" http://localhost:8081/dashboard/ | grep -q "200\|301\|302"; then
    log "Traefik not responding on dashboard port!"
    restart_traefik
    return
  fi
  
  # Check if dynamic config file exists and has proper structure
  DYNAMIC_CONFIG="$FRONT_DIR/config/dynamic.yml"
  if [ ! -f "$DYNAMIC_CONFIG" ] || ! grep -q "http:" "$DYNAMIC_CONFIG" || ! grep -q "tcp:" "$DYNAMIC_CONFIG"; then
    log "Dynamic configuration file missing or invalid!"
    fix_dynamic_config
    restart_traefik
    return
  fi
  
  log "Traefik is running normally"
}

# Main loop
log "Starting Traefik protection service..."

while true; do
  check_traefik
  sleep "$CHECK_INTERVAL"
done