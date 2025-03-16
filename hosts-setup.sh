#!/bin/bash
# Setup local hostnames for development

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run as root or with sudo"
  exit 1
fi

# Hostnames to add
HOSTS=(
  "traefik.localhost"
  "test.mongodb.localhost"
  "test2.mongodb.localhost"
  "apps.localhost"
)

# Check if each hostname is in /etc/hosts
for HOST in "${HOSTS[@]}"; do
  if ! grep -q "$HOST" /etc/hosts; then
    echo "Adding $HOST to /etc/hosts"
    echo "127.0.0.1 $HOST" >> /etc/hosts
  else
    echo "$HOST already in /etc/hosts"
  fi
done

echo "Host setup complete!" 