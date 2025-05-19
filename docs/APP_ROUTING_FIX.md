# CloudLunacy Front App Routing Fix

This document describes the issues with app routing in CloudLunacy Front and the fixes that have been implemented.

## Problem Description

There were two primary issues with the app routing system:

1. App subdomains were returning 404 errors
2. Agents were receiving 404 errors when accessing the `/proxy/routes` endpoint

## Root Causes

1. **Missing or Incorrect Middleware Configuration:**

   - The `app-routing` middleware chain was not properly defined in Consul KV
   - App routers were not using the correct middleware chain

2. **Incomplete Routing Configuration:**

   - The `apps` router with a wildcard rule for app subdomains was missing or improperly configured
   - The node-app-service wasn't correctly referenced by the router

3. **API Endpoint Format Issues:**
   - The `/proxy/routes` endpoint wasn't returning properly formatted responses
   - Error handling was insufficient, leading to unhandled exceptions

## Implemented Fixes

### 1. Added Comprehensive Fix Scripts

- Created `fix-app-routing.js` to update Consul KV store with correct middleware and router configuration
- Created `fix-app-routing-full.sh` to fix all aspects of the routing system

### 2. Enhanced API Response Format

- Updated the `/proxy/routes` endpoint to properly format responses
- Added proper error handling to prevent "routes.some is not a function" errors
- Integrated with both ProxyService and AppRegistrationService

### 3. Added Robust Testing

- Created `test-app-routing-detailed.sh` to validate the routing configuration
- Includes tests for API endpoints and Consul KV configuration

## How to Run the Fix

```bash
# Run the comprehensive fix script
bash scripts/fix-app-routing-full.sh

# Or run individual components:
node scripts/fix-app-routing.js
bash scripts/test-app-routing-detailed.sh
```

## Validation

After running the fix, you should see:

1. The `/proxy/routes` endpoint returns a valid JSON response with an array of routes
2. App subdomains properly resolve to the node-app service
3. Consul KV store contains the proper middleware and router configuration

## Technical Details

### App Routing Architecture

The app routing system uses a combination of:

1. **Traefik Dynamic Configuration:**

   - File-based configuration in `/config/traefik/dynamic/`
   - Consul KV store configuration under the `traefik/` prefix

2. **Middleware Chain:**

   - `app-routing` middleware combines `secure-headers`, `cors-headers`, and `compress`

3. **Wildcard Routing:**
   - The `apps` router uses a HostRegexp rule to match any subdomain of the app domain
   - High priority (100) ensures it takes precedence over other routes

### API Integration

- The node-app service handles both app registration and proxy configuration
- `AppRegistrationService` and `ProxyService` work together to manage routes
- The `/proxy/routes` endpoint combines data from both services

## Troubleshooting

If issues persist after running the fix:

1. Check Traefik logs:

   ```bash
   docker logs $(docker ps -f name=cloudlunacy_front_traefik --format "{{.ID}}") | tail -n 50
   ```

2. Verify Consul KV configuration:

   ```bash
   docker exec $(docker ps -f name=cloudlunacy_front_consul --format "{{.ID}}") consul kv get -recurse traefik/
   ```

3. Restart Traefik to reload configuration:
   ```bash
   docker exec $(docker ps -f name=cloudlunacy_front_traefik --format "{{.ID}}") kill -s HUP 1
   ```
