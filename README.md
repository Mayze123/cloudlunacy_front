# Front Door Service

A Node.js service for dynamically managing Traefik routing rules for MongoDB Docker instances

## Features

- **Dynamic Routing:** Automatically updates Traefik's dynamic configuration (`dynamic.yml`)
  to add new subdomain routes.
- **Secure API:** Provides an authenticated endpoint to add routes.
- **Hot-Reload:** Leverages Traefik’s file provider to pick up configuration changes
  without requiring a restart.
- **Easy Deployment:** Includes an installation script and systemd service configuration.

## Repository Structure
