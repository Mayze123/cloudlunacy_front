FROM haproxy:2.8-alpine

# Install required packages
RUN apk add --no-cache curl wget ca-certificates tar

# Install the Data Plane API
RUN mkdir -p /tmp/dataplaneapi \
    && cd /tmp/dataplaneapi \
    && wget -q https://github.com/haproxytech/dataplaneapi/releases/download/v2.8.0/dataplaneapi_2.8.0_Linux_x86_64.tar.gz \
    && tar xf dataplaneapi_2.8.0_Linux_x86_64.tar.gz \
    && cp dataplaneapi /usr/local/bin/ \
    && chmod +x /usr/local/bin/dataplaneapi \
    && rm -rf /tmp/dataplaneapi

# Make sure the Data Plane API can run
RUN mkdir -p /etc/haproxy/dataplaneapi

# Data Plane API startup script
COPY start-dataplaneapi.sh /usr/local/bin/start-dataplaneapi.sh
RUN chmod +x /usr/local/bin/start-dataplaneapi.sh

EXPOSE 80 443 8404 5555 27017

# Custom entrypoint script
COPY custom-entrypoint.sh /usr/local/bin/custom-entrypoint.sh
RUN chmod +x /usr/local/bin/custom-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/custom-entrypoint.sh"]
CMD ["haproxy", "-f", "/usr/local/etc/haproxy/haproxy.cfg"] 