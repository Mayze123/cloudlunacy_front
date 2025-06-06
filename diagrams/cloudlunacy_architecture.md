# CloudLunacy Front Server Architecture

This diagram explains how the CloudLunacy Front Server works, from initialization to handling proxy requests, using the Traefik API.

```mermaid
graph TD
    %% Main server components
    START[Server Starts] --> INIT[Initialize Path Manager & Core Services]
    INIT --> SERVER[HTTP Server Starts Listening]
    SERVER --> HEALTH[Schedule Health Checks]

    %% User requests
    REQ[HTTP Request Arrives] --> ROUTE{Route Type?}

    %% API routes
    ROUTE -->|API Request| API[API Router]
    API --> AUTH{Auth Required?}
    AUTH -->|Yes| CHECK[Check Authentication]
    AUTH -->|No| PROCESS[Process Request]
    CHECK -->|Success| PROCESS

    %% Services
    PROCESS --> SERVICE{Service Type?}
    SERVICE -->|Agent| AGENT[Agent Service]
    SERVICE -->|Proxy| PROXY[Proxy Service]
    SERVICE -->|Config| CONFIG[Config Service]

    %% Proxy service
    PROXY --> TRAEFIK[Traefik Service]

    %% Traefik API integration
    TRAEFIK --> FILE_PROVIDER[Traefik File Provider]
    FILE_PROVIDER --> UPDATE[Update Traefik Configuration]
    UPDATE --> RELOAD[Apply Changes]

    %% Health checks
    HEALTH --> CHECK_PROXY[Check Proxy Health]
    CHECK_PROXY --> UNHEALTHY{Is Healthy?}
    UNHEALTHY -->|No| REPAIR[Repair Proxy]
    UNHEALTHY -->|Yes| WAIT[Wait for Next Check]
    REPAIR --> WAIT

    %% Subgraph for proxy types
    subgraph "Proxy Types"
        HTTP[HTTP Routing]
        MONGO[MongoDB Routing]
    end

    PROXY --- HTTP
    PROXY --- MONGO

    %% Subgraph for Traefik operations
    subgraph "Traefik Operations"
        ADD_ROUTE[Add Route]
        REMOVE_ROUTE[Remove Route]
        GET_ROUTES[Get Routes]
    end

    TRAEFIK --- ADD_ROUTE
    TRAEFIK --- REMOVE_ROUTE
    TRAEFIK --- GET_ROUTES

    %% Styles
    classDef primary fill:#f9f,stroke:#333,stroke-width:2px;
    classDef service fill:#bbf,stroke:#33f,stroke-width:1px;
    classDef flow fill:#afa,stroke:#3a3,stroke-width:1px;
    classDef api fill:#ffa,stroke:#a93,stroke-width:1px;

    class START,SERVER primary;
    class AGENT,PROXY,CONFIG,TRAEFIK service;
    class REQ,PROCESS,UPDATE flow;
    class API,FILE_PROVIDER api;
```

## How It Works (in Simple Terms)

### 1. Startup Process

- **Server Initialization**: The application starts, loads environment variables, and sets up express server
- **Services Initialization**: Core services are initialized in the right order (Config → Traefik → Proxy → Agent)
- **Health Checks**: Regular checks ensure everything is running properly

### 2. Request Handling

- **Incoming Request**: When a request comes in, it goes through the API router
- **Authentication**: Most requests require authentication
- **Service Selection**: The request is directed to the appropriate service (Agent, Proxy, or Config)

### 3. Proxy Management

- **Proxy Service**: Handles routing requests to appropriate destinations
- **Traefik Service**: Communicates with Traefik using the File Provider configuration
- **Route Types**: Supports both HTTP routing and MongoDB routing

### 4. Traefik File Provider

- **Configuration Updates**: Changes to routes are written to YAML configuration files
- **Dynamic Configuration**: Traefik automatically detects and applies changes to configuration files
- **Health Monitoring**: Ensures Traefik is running correctly

### 5. Key Features

- **Dynamic Routing**: Add, remove, and modify routes without restarting
- **Authentication**: Secure API access
- **Health Repair**: Automatic detection and repair of configuration issues
- **Graceful Shutdown**: Handles termination signals appropriately

## Technical Components

| Component       | Purpose                                       |
| --------------- | --------------------------------------------- |
| Server.js       | Main entry point that starts everything       |
| Core Services   | Modular services for different functionality  |
| Traefik Service | Manages Traefik via File Provider             |
| Proxy Service   | High-level routing functionality              |
| Agent Service   | Manages agent registration and authentication |
| Config Service  | Handles configuration settings                |
