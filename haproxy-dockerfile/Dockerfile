FROM haproxy:3.1

# Install required tools
USER root
RUN apk add --no-cache curl wget unzip jq bash procps ca-certificates

# Install a specific version of Data Plane API that's compatible with HAProxy 3.1
RUN wget -q -O /tmp/dataplaneapi.zip https://github.com/haproxytech/dataplaneapi/releases/download/v2.8.3/dataplaneapi_2.8.3_linux_amd64.zip && \
    unzip -q /tmp/dataplaneapi.zip -d /usr/local/bin/ && \
    chmod +x /usr/local/bin/dataplaneapi && \
    rm /tmp/dataplaneapi.zip

# Create necessary directories
RUN mkdir -p /etc/haproxy/dataplaneapi /var/lib/haproxy/backups /var/log/haproxy /etc/haproxy/errors \
    /etc/haproxy/maps /etc/haproxy/spoe /tmp/certs/certs /tmp/certs/private /tmp/certs/agents

# Set proper permissions for Data Plane API
RUN chown -R haproxy:haproxy /etc/haproxy/dataplaneapi /var/lib/haproxy && \
    chmod 755 /etc/haproxy/dataplaneapi /var/lib/haproxy

# Copy sync-certificates script
COPY sync-certificates.sh /usr/local/bin/sync-certificates.sh
RUN chmod +x /usr/local/bin/sync-certificates.sh

# Copy custom entrypoint
COPY custom-entrypoint.sh /usr/local/bin/custom-entrypoint.sh
RUN chmod +x /usr/local/bin/custom-entrypoint.sh

# Expose only necessary ports
EXPOSE 80 443 8081 5555 27017

# Set entrypoint and default command
ENTRYPOINT ["/usr/local/bin/custom-entrypoint.sh"]
CMD []