#!/bin/bash
# Script to generate certificates for Traefik TLS termination of MongoDB connections

set -e

# Configuration
TRAEFIK_CERTS_DIR="./traefik-certs"
DOMAIN="mongodb.cloudlunacy.uk"

# Create directories
mkdir -p ${TRAEFIK_CERTS_DIR}

# Generate self-signed certificates for Traefik TLS termination
echo "Generating certificates for Traefik TLS termination of MongoDB..."
cd ${TRAEFIK_CERTS_DIR}

# Generate CA certificate if it doesn't exist
if [ ! -f ca.key ]; then
  echo "Generating new CA certificate..."
  openssl genrsa -out ca.key 4096
  openssl req -new -x509 -days 3650 -key ca.key -out ca.crt -subj "/CN=MongoDB CA/O=CloudLunacy/C=US"
else
  echo "Using existing CA certificate..."
fi

# Generate server certificate for Traefik
echo "Generating server certificate for Traefik..."
openssl genrsa -out server.key 4096
openssl req -new -key server.key -out server.csr -subj "/CN=${DOMAIN}/O=CloudLunacy/C=US"
# Add Subject Alternative Names for wildcard domains
cat > server.ext << EOL
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, nonRepudiation, keyEncipherment, dataEncipherment
subjectAltName = @alt_names

[alt_names]
DNS.1 = ${DOMAIN}
DNS.2 = *.${DOMAIN}
EOL

openssl x509 -req -days 3650 -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -extfile server.ext

# Generate client certificate for re-encryption (if needed)
echo "Generating client certificate for re-encryption..."
openssl genrsa -out client.key 4096
openssl req -new -key client.key -out client.csr -subj "/CN=traefik-client/O=CloudLunacy/C=US"
openssl x509 -req -days 3650 -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out client.crt

# Set proper permissions - fix the paths to be relative to current directory
chmod 600 *.key
chmod 644 *.crt

echo "Certificates generated in ${TRAEFIK_CERTS_DIR}"
echo "To use these certificates with Traefik, make sure they are mounted to the Traefik container"
echo "You will need to update your MongoDB configuration to either:"
echo "1. Accept unencrypted connections from Traefik (internal trusted network)"
echo "2. Use TLS but trust the CA certificate and accept connections from the Traefik client certificate" 