FROM haproxytech/haproxy:3.1

# Install required packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    wget \
    unzip \
    jq \
    vim \
    bash \
    procps \
    openssl \
    && rm -rf /var/lib/apt/lists/*

# Create necessary directories with proper permissions
RUN mkdir -p /etc/haproxy/errors /etc/haproxy/maps /etc/haproxy/spoe \
    && mkdir -p /tmp/certs/certs /tmp/certs/private /tmp/certs/agents \
    && mkdir -p /var/log \
    && touch /var/log/dataplaneapi.log \
    && chown -R haproxy:haproxy /etc/haproxy /tmp/certs /var/log/dataplaneapi.log \
    && chmod 644 /var/log/dataplaneapi.log

# Copy custom scripts
COPY install-dataplaneapi.sh /usr/local/bin/install-dataplaneapi.sh
COPY sync-certificates.sh /usr/local/bin/sync-certificates.sh
COPY custom-entrypoint.sh /usr/local/bin/custom-entrypoint.sh

# Make scripts executable
RUN chmod +x /usr/local/bin/install-dataplaneapi.sh \
    && chmod +x /usr/local/bin/sync-certificates.sh \
    && chmod +x /usr/local/bin/custom-entrypoint.sh

# Expose ports
EXPOSE 80 443 5555

# Set entrypoint
ENTRYPOINT ["/usr/local/bin/custom-entrypoint.sh"]

# Health check to verify HAProxy is running properly
HEALTHCHECK --interval=5s --timeout=3s --retries=3 \
  CMD curl -f http://localhost:5555/v3/health || exit 1