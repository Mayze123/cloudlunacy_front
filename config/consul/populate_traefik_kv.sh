#!/bin/sh

# Script to populate Consul KV with Traefik dynamic configuration
# Run this after the Consul server is up and healthy.

# Consul agent address (adjust if necessary, but defaults usually work within Docker Compose)
CONSUL_HTTP_ADDR="http://consul:8500"
KV_PREFIX="traefik" # Matches the prefix configured in traefik.yml

# --- Helper function to put KV pairs ---
put_kv() {
    key_path="$1"
    value="$2"
    echo "Putting: $KV_PREFIX/$key_path = $value"
    consul kv put "$KV_PREFIX/$key_path" "$value"
    # Add a small sleep to avoid overwhelming Consul agent if needed
    # sleep 0.1
}

# --- HTTP Middlewares ---

# Basic Auth (auth-admin)
# IMPORTANT: Replace this hash with a securely generated one!
# Use: htpasswd -nb admin YOUR_SECURE_PASSWORD
AUTH_ADMIN_HASH="${TRAEFIK_ADMIN_AUTH_HASH:-admin:$apr1$ruca84Hq$mbjdMZBAG.KWn7vfN/SNK/}" # Example: admin/password
put_kv "http/middlewares/auth-admin/basicauth/users" "$AUTH_ADMIN_HASH"

# Compress (compress)
put_kv "http/middlewares/compress/compress" "{}"

# Secure Headers (secure-headers)
put_kv "http/middlewares/secure-headers/headers/framedeny" "true"
put_kv "http/middlewares/secure-headers/headers/browserxssfilter" "true"
put_kv "http/middlewares/secure-headers/headers/contenttypenosniff" "true"
put_kv "http/middlewares/secure-headers/headers/forcestsheader" "true"
put_kv "http/middlewares/secure-headers/headers/stsincludesubdomains" "true"
put_kv "http/middlewares/secure-headers/headers/stspreload" "true"
put_kv "http/middlewares/secure-headers/headers/stsseconds" "31536000"

# CORS Headers (cors-headers) - Adjust origins as needed
CORS_ORIGINS="${CORS_ALLOWED_ORIGINS:-https://*.cloudlunacy.uk,https://*.apps.cloudlunacy.uk,http://localhost:3000}"
put_kv "http/middlewares/cors-headers/headers/accesscontrolallowmethods" "GET,POST,PUT,DELETE,OPTIONS"
put_kv "http/middlewares/cors-headers/headers/accesscontrolalloworiginlist" "$CORS_ORIGINS"
put_kv "http/middlewares/cors-headers/headers/accesscontrolallowcredentials" "true"
put_kv "http/middlewares/cors-headers/headers/accesscontrolmaxage" "100"
put_kv "http/middlewares/cors-headers/headers/addvaryheader" "true"

# --- TCP Router (mongodb) ---
# COMMENTED OUT: We don't want a wildcard router that would conflict with agent-specific routers
# MONGO_ROUTER_RULE="${MONGO_ROUTER_RULE:-HostSNI(\\`*\\`)}" # Default to wildcard, escape backticks for shell
# put_kv "tcp/routers/mongodb/entrypoints" "mongodb"
# put_kv "tcp/routers/mongodb/rule" "$MONGO_ROUTER_RULE" # e.g., HostSNI(\`mongodb.cloudlunacy.uk\`)
# put_kv "tcp/routers/mongodb/service" "mongodb-service"
# put_kv "tcp/routers/mongodb/tls/passthrough" "true"

# --- TCP Service (mongodb-service) ---
# COMMENTED OUT: We don't want a default service that would conflict with agent-specific services
# MONGO_SERVICE_ADDRESS="${MONGO_SERVICE_ADDRESS:-mongo:27017}"
# put_kv "tcp/services/mongodb-service/loadbalancer/servers/0/address" "$MONGO_SERVICE_ADDRESS"

echo "Traefik dynamic configuration populated in Consul KV." 