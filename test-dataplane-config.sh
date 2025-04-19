#!/bin/bash

# Set terminal colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
API_HOST=${1:-"localhost"}
API_PORT=${2:-"5555"}
API_USER=${3:-"admin"}
API_PASS=${4:-"admin"}
API_BASE="http://${API_HOST}:${API_PORT}/v3"

# Function to log messages
log() {
  local level=$1
  local message=$2
  timestamp=$(date +"%Y-%m-%d %H:%M:%S")
  
  case $level in
    "info")
      echo -e "${timestamp} - ${BLUE}INFO${NC}: $message"
      ;;
    "success")
      echo -e "${timestamp} - ${GREEN}SUCCESS${NC}: $message"
      ;;
    "warning")
      echo -e "${timestamp} - ${YELLOW}WARNING${NC}: $message"
      ;;
    "error")
      echo -e "${timestamp} - ${RED}ERROR${NC}: $message"
      ;;
    *)
      echo -e "${timestamp} - $message"
      ;;
  esac
}

# Function to make API calls with authentication
call_api() {
  local endpoint=$1
  local method=${2:-"GET"}
  local data=$3
  
  if [ -n "$data" ]; then
    curl -s -X $method -u "${API_USER}:${API_PASS}" -H "Content-Type: application/json" -d "$data" "${API_BASE}${endpoint}"
  else
    curl -s -X $method -u "${API_USER}:${API_PASS}" "${API_BASE}${endpoint}"
  fi
}

# Check if Data Plane API is running
check_health() {
  log "info" "Checking HAProxy Data Plane API health..."
  
  local response
  response=$(call_api "/health")
  
  if [[ "$response" == *"OK"* ]]; then
    log "success" "Data Plane API is healthy!"
    return 0
  else
    log "error" "Data Plane API is not responding or unhealthy"
    return 1
  fi
}

# Get and display frontends
get_frontends() {
  log "info" "Retrieving frontends from HAProxy Data Plane API..."
  
  local response
  response=$(call_api "/services/haproxy/configuration/frontends")
  
  if [ -z "$response" ] || [[ "$response" == *"error"* ]]; then
    log "error" "Failed to retrieve frontends"
    return 1
  fi
  
  # Format and display frontends
  echo -e "\n${BLUE}====== FRONTENDS ======${NC}"
  
  # Use jq if available, otherwise parse with grep
  if command -v jq &> /dev/null; then
    echo "$response" | jq -r '.[] | "Name: \(.name)\nMode: \(.mode)\nDefault Backend: \(.default_backend)\nBind: \(.binds[].name)"'
  else
    # Simple parsing with grep
    echo "$response" | grep -oE '"name":"[^"]*"|"mode":"[^"]*"|"default_backend":"[^"]*"' | sed 's/"name":"/Name: /g; s/"mode":"/Mode: /g; s/"default_backend":"/Default Backend: /g; s/"//g'
  fi
  
  echo -e "${BLUE}======================${NC}\n"
}

# Get and display backends
get_backends() {
  log "info" "Retrieving backends from HAProxy Data Plane API..."
  
  local response
  response=$(call_api "/services/haproxy/configuration/backends")
  
  if [ -z "$response" ] || [[ "$response" == *"error"* ]]; then
    log "error" "Failed to retrieve backends"
    return 1
  fi
  
  # Format and display backends
  echo -e "\n${BLUE}====== BACKENDS ======${NC}"
  
  # Use jq if available, otherwise parse with grep
  if command -v jq &> /dev/null; then
    echo "$response" | jq -r '.[] | "Name: \(.name)\nMode: \(.mode)\nBalance Algorithm: \(.balance.algorithm)"'
    
    # Get servers for each backend
    backends=$(echo "$response" | jq -r '.[].name')
    for backend in $backends; do
      servers_response=$(call_api "/services/haproxy/configuration/servers?backend=$backend")
      echo -e "\n${YELLOW}Servers for backend '$backend':${NC}"
      echo "$servers_response" | jq -r '.[] | "  - \(.name): \(.address):\(.port)"'
    done
  else
    # Simple parsing with grep
    echo "$response" | grep -oE '"name":"[^"]*"|"mode":"[^"]*"|"balance":{"algorithm":"[^"]*"}' | sed 's/"name":"/Name: /g; s/"mode":"/Mode: /g; s/"balance":{"algorithm":"/Balance Algorithm: /g; s/"//g; s/}//g'
  fi
  
  echo -e "${BLUE}======================${NC}\n"
}

# Get detailed information about a specific frontend or backend
get_detail() {
  local type=$1
  local name=$2
  
  log "info" "Retrieving detailed information for $type '$name'..."
  
  local response
  response=$(call_api "/services/haproxy/configuration/${type}s/$name")
  
  if [ -z "$response" ] || [[ "$response" == *"error"* ]]; then
    log "error" "Failed to retrieve details for $type '$name'"
    return 1
  fi
  
  # Format and display details
  echo -e "\n${BLUE}====== $type DETAILS: $name ======${NC}"
  
  # Use jq if available
  if command -v jq &> /dev/null; then
    echo "$response" | jq
  else
    # Just print the response with some formatting
    echo "$response" | sed 's/,/,\n/g; s/{/{\n/g; s/}/\n}/g'
  fi
  
  echo -e "${BLUE}======================${NC}\n"
}

# Get rules (ACLs) for a specific frontend
get_rules() {
  local frontend=$1
  
  log "info" "Retrieving ACL rules for frontend '$frontend'..."
  
  local response
  response=$(call_api "/services/haproxy/configuration/acls?parent_type=frontend&parent_name=$frontend")
  
  if [ -z "$response" ] || [[ "$response" == *"error"* ]]; then
    log "error" "Failed to retrieve ACL rules for frontend '$frontend'"
    return 1
  fi
  
  # Format and display rules
  echo -e "\n${BLUE}====== RULES FOR FRONTEND: $frontend ======${NC}"
  
  # Use jq if available
  if command -v jq &> /dev/null; then
    echo "$response" | jq -r '.[] | "ACL: \(.acl_name)\nCriterion: \(.criterion)\nValue: \(.value)"'
  else
    # Simple parsing with grep
    echo "$response" | grep -oE '"acl_name":"[^"]*"|"criterion":"[^"]*"|"value":"[^"]*"' | sed 's/"acl_name":"/ACL: /g; s/"criterion":"/Criterion: /g; s/"value":"/Value: /g; s/"//g'
  fi
  
  echo -e "${BLUE}======================${NC}\n"
}

# Main execution
main() {
  log "info" "Starting HAProxy Data Plane API configuration test..."
  
  # Check if the Data Plane API is running
  if ! check_health; then
    log "error" "Data Plane API health check failed. Exiting."
    return 1
  fi
  
  # Get and display frontends
  get_frontends
  
  # Get and display backends
  get_backends
  
  # Optional: Ask user if they want to see details for a specific frontend or backend
  read -p "Do you want to see details for a specific frontend or backend? (y/n): " show_details
  
  if [[ "$show_details" =~ ^[Yy]$ ]]; then
    read -p "Enter type (frontend/backend): " detail_type
    read -p "Enter name: " detail_name
    
    get_detail "$detail_type" "$detail_name"
    
    if [[ "$detail_type" == "frontend" ]]; then
      read -p "Do you want to see ACL rules for this frontend? (y/n): " show_rules
      
      if [[ "$show_rules" =~ ^[Yy]$ ]]; then
        get_rules "$detail_name"
      fi
    fi
  fi
  
  log "success" "HAProxy Data Plane API configuration test completed!"
}

# Execute main function
main