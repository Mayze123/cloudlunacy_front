# CloudLunacy Front - Local Development Guide

This guide explains how to set up and run the CloudLunacy Front project in a local development environment using Docker.

## Prerequisites

- Docker and Docker Compose installed
- Git
- Node.js (optional, for running scripts outside Docker)

## Quick Start

1. Clone the repository:

   ```bash
   git clone https://github.com/Mayze123/cloudlunacy_front.git
   cd cloudlunacy_front
   ```

2. Start the development environment:

   ```bash
   # Make the start script executable
   chmod +x start-dev.sh

   # Start the development environment
   ./start-dev.sh
   ```

   Alternatively, you can use npm:

   ```bash
   cd node-app
   npm run dev:docker
   ```

3. Access the services:
   - Node.js API: http://localhost:3005
   - HAProxy Stats: http://haproxy.localhost:8081/stats
   - Test MongoDB: mongodb://admin:password@test.mongodb.localhost:27017

## Development Environment

The development setup includes:

- **HAProxy**: Reverse proxy with stats dashboard
- **Node.js App**: The CloudLunacy Front application with hot-reloading
- **Test MongoDB**: A MongoDB instance for testing

## Directory Structure

- `config/`: Configuration files for HAProxy
  - `haproxy/`: HAProxy configuration directory
  - `haproxy/haproxy.cfg`: HAProxy configuration file
- `logs/`: Log files
- `node-app/`: The Node.js application code
- `config/haproxy/certs/`: SSL certificates for HAProxy

## Testing MongoDB Routing

1. The test MongoDB instance is available at:

   ```
   mongodb://admin:password@test.mongodb.localhost:27017
   ```

2. To test adding a new MongoDB route:

   ```bash
   curl -X POST http://localhost:3005/api/routes/mongo \
     -H "Content-Type: application/json" \
     -d '{"agentId": "test2", "targetHost": "mongodb-test", "targetPort": 27017}'
   ```

3. Then connect to the new route:
   ```
   mongodb://admin:password@test2.mongodb.localhost:27017
   ```

## Troubleshooting

### Port Conflicts

If you see errors about ports already in use, you may have services running on ports 80, 443, 8081, or 27017. Stop those services or modify the port mappings in `docker-compose.dev.yml`.

### Hostname Resolution

Add the following entries to your `/etc/hosts` file:

````
127.0.0.1 haproxy.localhost
127.0.0.1 test.mongodb.localhost
127.0.0.1 test2.mongodb.localhost
127.0.0.1 apps.localhost

### Docker Network Issues
If containers can't communicate, try recreating the networks:

```bash
docker network rm haproxy-network cloudlunacy-network
docker network create haproxy-network
docker network create cloudlunacy-network
````

## Stopping the Environment

To stop the development environment:

```bash
# If started with docker-compose directly
docker-compose -f docker-compose.dev.yml down

# Or if using npm
cd node-app
npm run dev:docker:down
```

## Additional Tips

### Viewing Logs

To view logs from a specific container:

```bash
docker logs haproxy-dev
docker logs cloudlunacy-front-dev
docker logs mongodb-test
```

### Accessing Container Shell

To access a shell in a container:

```bash
docker exec -it cloudlunacy-front-dev sh
docker exec -it haproxy-dev sh
docker exec -it mongodb-test bash
```

### Restarting Services

To restart a specific service:

```bash
docker-compose -f docker-compose.dev.yml restart node-app
```

# MongoDB Testing

For MongoDB testing, please use the agent project's development environment. The front project only handles routing and management of MongoDB connections, but does not include a MongoDB instance.

If you need to test MongoDB routing functionality:

1. Start the agent project's development environment which includes MongoDB on port 27017
2. Configure the front project to route to the agent's MongoDB instance
3. Note that the front project's HAProxy is configured to listen on port 27018 for MongoDB connections to avoid conflicts

To connect to MongoDB through the front project's routing:

```
mongodb://username:password@agentid.mongodb.localhost:27018/admin
```

# Development Environment Setup

## Port Allocations

To avoid conflicts between the front and agent projects, we use the following port allocations:

| Service     | Front Project   | Agent Project |
| ----------- | --------------- | ------------- |
| Node.js API | 3005            | 3006          |
| MongoDB     | 27018 (HAProxy) | 27017         |

When testing both projects together, make sure to use the correct ports for each service.
