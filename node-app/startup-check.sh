#!/bin/bash
set -e

echo "Running node-app startup checks..."

# Check if the app port is defined
APP_PORT="${NODE_PORT:-3005}"
echo "Node app should be running on port: $APP_PORT"

# Check if the process is listening on the expected port
if netstat -tuln | grep -q ":$APP_PORT "; then
    echo "✅ Node app is listening on port $APP_PORT"
else
    echo "❌ Node app is NOT listening on port $APP_PORT!"
    echo "Current listening ports:"
    netstat -tuln | grep LISTEN
    
    echo "Starting diagnostics..."
    
    # Check Node.js process
    NODE_PROCESS=$(ps aux | grep node | grep -v grep || echo "No Node.js process found")
    echo "Node.js processes: $NODE_PROCESS"
    
    # Check application logs
    echo "Last 20 lines of application logs:"
    tail -n 20 /app/logs/app.log || echo "Log file not found"
    
    # Check disk space
    echo "Disk space:"
    df -h
    
    # Check memory usage
    echo "Memory usage:"
    free -m || echo "free command not available"
    
    echo "Try manually starting the application:"
    echo "docker exec -it cloudlunacy-front node /app/server.js"
    
    exit 1
fi

# Check network connectivity
echo "Checking network interfaces:"
ip addr show || echo "ip command not available"

# Ensure app is reachable via health endpoint
if curl -s http://localhost:$APP_PORT/health > /dev/null; then
    echo "✅ Health endpoint is reachable"
else
    echo "❌ Health endpoint is NOT reachable!"
    echo "This might indicate the application is not properly handling requests."
    
    # Try a more detailed check
    curl -v http://localhost:$APP_PORT/health || echo "Failed to connect to health endpoint"
    
    # Suggest potential solutions
    echo "Try checking the application logs and restarting the application."
    
    exit 1
fi

echo "✅ All startup checks passed!" 