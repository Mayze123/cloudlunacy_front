#!/bin/bash
# Read environment variables
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

# Use the configured network or default to traefik-network
NETWORK=${DOCKER_NETWORK:-traefik-network}
DOMAIN=${APP_DOMAIN:-apps.cloudlunacy.uk}

echo "Using Docker network: $NETWORK"
echo "Using domain: $DOMAIN"

# Create a simple test site
mkdir -p ./test-site
cat > ./test-site/index.html << END
<!DOCTYPE html>
<html>
<head>
    <title>Traefik Test</title>
</head>
<body>
    <h1>Traefik is working!</h1>
    <p>If you can see this page, your Traefik configuration is correct.</p>
    <p>Current time: $(date)</p>
</body>
</html>
END

# Create Dockerfile for the test site
cat > ./test-site/Dockerfile << END
FROM nginx:alpine
COPY index.html /usr/share/nginx/html/index.html
END

# Check if the network exists, create it if it doesn't
if ! docker network inspect "$NETWORK" &>/dev/null; then
  echo "Network $NETWORK does not exist. Creating it..."
  docker network create "$NETWORK"
fi

# Build and run the test container
cd ./test-site
docker build -t test-site .

# Remove the container if it already exists
docker rm -f test-site 2>/dev/null || true

docker run -d --name test-site \
  --network="$NETWORK" \
  --label "traefik.enable=true" \
  --label "traefik.http.routers.test-site.rule=Host(\`test.$DOMAIN\`)" \
  --label "traefik.http.routers.test-site.entrypoints=web,websecure" \
  --label "traefik.http.routers.test-site.tls.certresolver=letsencrypt" \
  test-site

echo "Test container created. Try accessing http://test.$DOMAIN"