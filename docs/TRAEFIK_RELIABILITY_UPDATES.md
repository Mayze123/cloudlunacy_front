# Traefik and Consul Integration Reliability Updates

This document describes reliability improvements made to the Traefik and Consul integration in CloudLunacy Front Server.

## Changes Implemented

### API Code Improvements

1. **ConsulService Error Handling**

   - `ConsulService.set()` now throws errors instead of returning false
   - This allows proper error propagation and prevents silent failures

2. **Service Initialization**

   - `AppRegistrationService` now waits for both itself and `ConsulService` to be fully initialized
   - Only marks `initialized = true` when both services are ready
   - Prevents race conditions in registration of apps and routes

3. **HTTP Route Registration**
   - `ProxyService.addHttpRoute()` now properly handles errors from `ConsulService.set()`
   - Improved error reporting with more specific messages

### Traefik Static Configuration Improvements

1. **Consul Provider**

   - Added `watch: true` to ensure KV changes are live-loaded
   - Removed stray `endpoint:` block under `providers.file` section

2. **DNS and ACME**
   - Added wildcard support for `*.apps.${APP_DOMAIN}` in the ACME resolver
   - Ensures TLS works correctly for all subdomains
   - Temporarily disabled HTTP to HTTPS redirect for testing purposes

## Verification Steps

To verify the changes are working correctly, you can:

1. **Check Consul KV Entries**

   ```bash
   docker exec consul consul kv get traefik/http/routers/<agent>-<subdomain>
   ```

2. **Check Traefik Logs**

   ```bash
   docker logs traefik | grep "Consul provider: loaded routers"
   ```

3. **Test HTTP Routing**

   ```bash
   curl -v http://myapp.apps.cloudlunacy.uk
   ```

4. **Test HTTPS Routing**

   ```bash
   curl -vk https://myapp.apps.cloudlunacy.uk
   ```

5. **Run the Verification Script**
   ```bash
   ./scripts/verify-app-config.sh <agent-id> <subdomain>
   ```

## Restoring HTTP to HTTPS Redirect

After completing testing, restore the HTTP to HTTPS redirect by uncommenting the relevant section in `config/traefik/traefik.yml`:

```yaml
web:
  address: ":80"
  http:
    redirections:
      entryPoint:
        to: websecure
        scheme: https
        permanent: true
```

## Troubleshooting

If issues persist:

1. Check that Consul service is healthy:

   ```bash
   curl -s http://localhost:8500/v1/status/leader | jq
   ```

2. Ensure Traefik is watching Consul:

   ```bash
   grep -A3 "consul" config/traefik/traefik.yml
   ```

3. Verify that DNS is correctly configured for wildcard domains
