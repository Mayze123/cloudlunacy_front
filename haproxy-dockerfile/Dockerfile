FROM haproxy:2.8-alpine

# Switch to root user for installations
USER root

# Install required packages
RUN apk add --no-cache curl wget ca-certificates tar

# Create necessary directories
RUN mkdir -p /etc/haproxy/dataplaneapi && \
    chmod 777 /etc/haproxy/dataplaneapi

# Download and install dataplaneapi directly (using the correct URL format)
RUN wget -q https://github.com/haproxytech/dataplaneapi/releases/download/v2.6.0/dataplaneapi_2.6.0_Linux_amd64 -O /usr/local/bin/dataplaneapi && \
    chmod +x /usr/local/bin/dataplaneapi && \
    /usr/local/bin/dataplaneapi -v

# Copy start scripts
COPY start-dataplaneapi.sh /usr/local/bin/start-dataplaneapi.sh
COPY custom-entrypoint.sh /usr/local/bin/custom-entrypoint.sh

# Set permissions
RUN chmod +x /usr/local/bin/start-dataplaneapi.sh && \
    chmod +x /usr/local/bin/custom-entrypoint.sh

# Expose ports
EXPOSE 80 443 8404 5555 27017

# Switch back to haproxy user
USER haproxy

# Set entrypoint and default command
ENTRYPOINT ["/usr/local/bin/custom-entrypoint.sh"]
CMD ["haproxy", "-f", "/usr/local/etc/haproxy/haproxy.cfg"] 