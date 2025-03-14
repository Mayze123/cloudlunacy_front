#!/bin/bash
# MongoDB TLS Configuration Script for CloudLunacy Agent

set -e

# Configuration
MONGO_CONFIG_DIR="/opt/cloudlunacy/mongodb"
MONGO_CERTS_DIR="${MONGO_CONFIG_DIR}/certs"
MONGO_PORT=27017

# Create directories
mkdir -p ${MONGO_CONFIG_DIR}
mkdir -p ${MONGO_CERTS_DIR}

# Generate self-signed certificates for MongoDB
echo "Generating self-signed certificates for MongoDB..."
cd ${MONGO_CERTS_DIR}

# Generate CA certificate
openssl genrsa -out ca.key 4096
openssl req -new -x509 -days 3650 -key ca.key -out ca.crt -subj "/CN=MongoDB CA/O=CloudLunacy/C=US"

# Generate server certificate
openssl genrsa -out server.key 4096
openssl req -new -key server.key -out server.csr -subj "/CN=mongodb/O=CloudLunacy/C=US"
openssl x509 -req -days 3650 -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt

# Generate client certificate
openssl genrsa -out client.key 4096
openssl req -new -key client.key -out client.csr -subj "/CN=client/O=CloudLunacy/C=US"
openssl x509 -req -days 3650 -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out client.crt

# Set proper permissions
chmod 600 ${MONGO_CERTS_DIR}/*.key
chmod 644 ${MONGO_CERTS_DIR}/*.crt

# Create MongoDB configuration file with TLS settings
cat > ${MONGO_CONFIG_DIR}/mongod.conf << EOL
security:
  authorization: enabled
net:
  bindIp: 0.0.0.0
  port: ${MONGO_PORT}
  maxIncomingConnections: 100
  tls:
    mode: requireTLS
    certificateKeyFile: /etc/mongo/certs/server.key
    certificateKeyFilePassword: 
    CAFile: /etc/mongo/certs/ca.crt
setParameter:
  failIndexKeyTooLong: false
  authenticationMechanisms: SCRAM-SHA-1,SCRAM-SHA-256
operationProfiling:
  slowOpThresholdMs: 100
  mode: slowOp
EOL

echo "MongoDB TLS configuration created at ${MONGO_CONFIG_DIR}/mongod.conf"
echo "Certificates generated in ${MONGO_CERTS_DIR}" 