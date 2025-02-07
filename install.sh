#!/bin/bash
# install.sh
#
# This script installs the Front Door Service on your VPS.
# It clones (or updates) the GitHub repository, installs Node.js dependencies,
# and sets up a systemd service so that the service starts on boot.
#
# Usage:
#  git reset --hard HEAD chmod +x install.sh sudo ./install.sh
#   sudo ./install.sh

set -e

SERVICE_NAME="frontdoor-service"
INSTALL_DIR="/opt/${SERVICE_NAME}"
REPO_URL="https://github.com/Mayze123/cloudlunacy_front.git"

# Ensure the script is run as root
if [ "$(id -u)" -ne 0 ]; then
  echo "[ERROR] This script must be run as root."
  exit 1
fi

# Clone or update the repository
if [ ! -d "$INSTALL_DIR" ]; then
  git clone "$REPO_URL" "$INSTALL_DIR"
else
  cd "$INSTALL_DIR"
  git pull origin main
fi

cd "$INSTALL_DIR"

echo "[INFO] Installing Node.js dependencies..."
npm install --production

echo "[INFO] Creating Docker network if needed..."
if ! docker network inspect traefik_network >/dev/null 2>&1; then
    docker network create traefik_network
    echo "[INFO] Created traefik_network successfully"
else
    echo "[INFO] traefik_network already exists"
fi

echo "[INFO] Setting up systemd service..."

SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Front Door Service for managing Traefik routes
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/node ${INSTALL_DIR}/frontdoorService.js
Restart=always
RestartSec=10
EnvironmentFile=${INSTALL_DIR}/.env

[Install]
WantedBy=multi-user.target
EOF

echo "[INFO] Reloading systemd daemon..."
systemctl daemon-reload

echo "[INFO] Enabling and starting ${SERVICE_NAME} service..."
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

echo "[INFO] Front Door Service installation completed successfully."