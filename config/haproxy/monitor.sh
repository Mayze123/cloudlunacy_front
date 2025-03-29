#!/bin/bash

# Monitoring script for HAProxy and Node.js app - runs as a cron job or in a continuous loop
# Periodically checks health and attempts to fix issues automatically

# Colors for better readability
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

# Configuration
HAPROXY_CONTAINER="${HAPROXY_CONTAINER:-haproxy}"
NODE_APP_CONTAINER="${NODE_APP_CONTAINER:-cloudlunacy-front}"
CHECK_INTERVAL="${CHECK_INTERVAL:-60}" # Check every 60 seconds
LOG_FILE="logs/haproxy-monitor.log"
SLACK_WEBHOOK_URL="${SLACK_WEBHOOK_URL:-}" # Optional Slack webhook for alerts

# Create logs directory if it doesn't exist
mkdir -p logs

log() {
    local message="$1"
    local timestamp=$(date "+%Y-%m-%d %H:%M:%S")
    echo -e "${timestamp} - $message" | tee -a "$LOG_FILE"
}

send_alert() {
    local message="$1"
    local severity="${2:-warning}" # warning, critical, info
    
    log "ALERT ($severity): $message"
    
    # Send to Slack if configured
    if [ -n "$SLACK_WEBHOOK_URL" ]; then
        local color="warning"
        [ "$severity" = "critical" ] && color="danger"
        [ "$severity" = "info" ] && color="good"
        
        curl -s -X POST -H 'Content-type: application/json' \
            --data "{\"text\":\"HAProxy Monitor Alert\", \"attachments\": [{\"color\": \"$color\", \"text\": \"$message\"}]}" \
            "$SLACK_WEBHOOK_URL" > /dev/null || true
    fi
}

check_and_fix() {
    log "Starting health check..."
    
    # Check if containers are running
    HAPROXY_RUNNING=$(docker ps -q -f "name=${HAPROXY_CONTAINER}" | wc -l)
    NODE_APP_RUNNING=$(docker ps -q -f "name=${NODE_APP_CONTAINER}" | wc -l)
    
    # Check HAProxy container
    if [ "$HAPROXY_RUNNING" -eq "0" ]; then
        send_alert "HAProxy container is not running! Attempting to start it..." "critical"
        docker start "$HAPROXY_CONTAINER" || send_alert "Failed to start HAProxy container!" "critical"
    fi
    
    # Check Node App container
    if [ "$NODE_APP_RUNNING" -eq "0" ]; then
        send_alert "Node App container is not running! Attempting to start it..." "critical"
        docker start "$NODE_APP_CONTAINER" || send_alert "Failed to start Node App container!" "critical"
    fi
    
    # If both containers are running, check connectivity
    if [ "$HAPROXY_RUNNING" -eq "1" ] && [ "$NODE_APP_RUNNING" -eq "1" ]; then
        # Check if HAProxy can reach node-app
        if ! docker exec "$HAPROXY_CONTAINER" ping -c 1 node-app > /dev/null 2>&1; then
            send_alert "HAProxy cannot reach node-app! Attempting to fix network connectivity..." "critical"
            
            # Run the fix-networking script
            ./config/haproxy/fix-networking.sh >> "$LOG_FILE" 2>&1 || send_alert "Failed to fix network connectivity!" "critical"
        fi
        
        # Check if HAProxy is serving requests
        if ! curl -s http://localhost:80 > /dev/null 2>&1; then
            send_alert "HAProxy is not serving HTTP requests! Checking configuration..." "critical"
            
            # Check if configuration is valid
            if ! docker exec "$HAPROXY_CONTAINER" haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg > /dev/null 2>&1; then
                send_alert "HAProxy configuration is invalid! Manual intervention required." "critical"
            else
                send_alert "HAProxy configuration is valid but service is not responding. Restarting HAProxy..." "warning"
                docker restart "$HAPROXY_CONTAINER" || send_alert "Failed to restart HAProxy!" "critical"
            fi
        fi
        
        # Check if node-app is responding to health checks
        if ! docker exec "$HAPROXY_CONTAINER" curl -s http://node-app:3005/health > /dev/null 2>&1; then
            send_alert "Node App is not responding to health checks! Restarting Node App..." "warning"
            docker restart "$NODE_APP_CONTAINER" || send_alert "Failed to restart Node App!" "critical"
        fi
    fi
    
    log "Health check completed."
}

# Run once or in a loop
if [ "$1" = "--once" ]; then
    check_and_fix
else
    log "Starting HAProxy monitor in continuous mode (press Ctrl+C to stop)"
    while true; do
        check_and_fix
        sleep "$CHECK_INTERVAL"
    done
fi 