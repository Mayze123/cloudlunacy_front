#!/bin/bash

# Create a simple test site
mkdir -p ./test-site
cat > ./test-site/index.html << 'END'
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
cat > ./test-site/Dockerfile << 'END'
FROM nginx:alpine
COPY index.html /usr/share/nginx/html/index.html
END

# Build and run the test container
cd ./test-site
docker build -t test-site .
docker run -d --name test-site \
  --network=traefik_network \
  --label "traefik.enable=true" \
  --label "traefik.http.routers.test-site.rule=Host(\`test.apps.cloudlunacy.uk\`)" \
  --label "traefik.http.routers.test-site.entrypoints=web,websecure" \
  --label "traefik.http.routers.test-site.tls.certresolver=letsencrypt" \
  test-site

echo "Test container created. Try accessing http://test.apps.cloudlunacy.uk"