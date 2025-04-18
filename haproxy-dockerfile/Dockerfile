FROM haproxy:3.1

# Install required tools
USER root
RUN apk add --no-cache curl

# Create necessary directories
RUN mkdir -p /etc/haproxy/dataplaneapi /var/lib/haproxy/backups /var/log/haproxy /etc/haproxy/errors

# Copy custom entrypoint
COPY custom-entrypoint.sh /usr/local/bin/custom-entrypoint.sh
RUN chmod +x /usr/local/bin/custom-entrypoint.sh

# Expose only necessary ports
EXPOSE 80 443 8081 5555 27017

# Set entrypoint and default command
ENTRYPOINT ["/usr/local/bin/custom-entrypoint.sh"]
CMD []