FROM haproxy:2.8-alpine

# Switch to root user for installations
USER root

# Install required packages
RUN apk add --no-cache curl socat

# Create necessary directories
RUN mkdir -p /etc/haproxy/dataplaneapi && \
    chmod 777 /etc/haproxy/dataplaneapi

# Create simple HAProxy config for testing
RUN echo "global\n\
    log stdout format raw local0 info\n\
    stats socket /var/run/haproxy.sock mode 666 level admin expose-fd listeners\n\
\n\
defaults\n\
    log global\n\
    mode http\n\
    timeout connect 5s\n\
    timeout client 30s\n\
    timeout server 30s\n\
\n\
userlist dataplaneapi\n\
    user admin insecure-password admin\n\
\n\
frontend stats\n\
    bind *:8404\n\
    stats enable\n\
    stats uri /stats\n\
    stats refresh 10s\n\
    stats auth admin:admin\n\
\n\
frontend api\n\
    bind *:5555\n\
    default_backend api\n\
\n\
backend api\n\
    server api1 127.0.0.1:8404\n\
" > /usr/local/etc/haproxy/dataplaneapi.cfg

# Create startup script
COPY custom-entrypoint.sh /usr/local/bin/custom-entrypoint.sh
RUN chmod +x /usr/local/bin/custom-entrypoint.sh

# Expose ports
EXPOSE 80 443 8404 5555 27017

# Set entrypoint and default command
ENTRYPOINT ["/usr/local/bin/custom-entrypoint.sh"]
CMD ["haproxy", "-f", "/usr/local/etc/haproxy/haproxy.cfg"] 