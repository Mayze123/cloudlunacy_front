#!/bin/bash
# Archive redundant files to clean up the project structure

# Create necessary archive directories
mkdir -p node-app/archive/services/core
mkdir -p node-app/archive/utils
mkdir -p node-app/archive/api

# Move redundant HAProxy and routing files
echo "Archiving redundant HAProxy and routing files..."
mv node-app/backup/services/core/haproxyManager.js node-app/archive/services/core/
mv node-app/backup/services/core/haproxyConfigManager.js node-app/archive/services/core/
mv node-app/backup/services/core/routingManager.js node-app/archive/services/core/
mv node-app/backup/services/core/routingService.js node-app/archive/services/core/
mv node-app/backup/services/core/configManager.js node-app/archive/services/core/

# Create README in the archive directory explaining what's stored there
cat > node-app/archive/README.md << 'README_EOF'
# Archived Files

This directory contains older versions of files that have been replaced or consolidated in the main codebase.
These files are kept for reference purposes but are no longer part of the active codebase.

## Services/Core

- **haproxyManager.js**: Legacy HAProxy management using direct configuration file manipulation
- **haproxyConfigManager.js**: Legacy HAProxy configuration management (replaced by Data Plane API approach)
- **routingManager.js**: Old routing management logic (consolidated into proxyService.js)
- **routingService.js**: Another routing implementation (consolidated into proxyService.js)
- **configManager.js**: Old configuration management (moved to utils/configManager.js)

These files were archived during the cleanup phase on April 12, 2025, as part of the system enhancement initiative.
README_EOF

echo "Redundant files have been archived to node-app/archive/"
