# CloudLunacy Data Flow

This diagram explains how data flows through the CloudLunacy Front Server when handling proxy requests.

```mermaid
flowchart LR
    %% External entities
    CLIENT[Client] <--> DOMAINS{Domain Type}
    DOMAINS -->|app.subdomain| HTTP_FRONT[HTTP Frontend]
    DOMAINS -->|mongodb.subdomain| MONGO_FRONT[MongoDB Frontend]

    %% HAProxy
    subgraph HAPROXY[HAProxy]
        HTTP_FRONT --> FRONTEND[Frontend Processing]
        MONGO_FRONT --> FRONTEND
        FRONTEND --> ACL{ACL Matching}
        ACL -->|Match Found| BACKEND_SELECT[Backend Selection]
        BACKEND_SELECT --> BACKENDS[(Configured Backends)]
    end

    %% Backend targets
    BACKENDS --> APP_SERVERS[Application Servers]
    BACKENDS --> DB_SERVERS[Database Servers]

    %% Management flow
    ADMIN[Administrator] --> API_SERVER[API Server]
    API_SERVER --> PROXY_SERVICE[Proxy Service]
    PROXY_SERVICE --> HAPROXY_SERVICE[HAProxy Service]

    %% Data plane API
    HAPROXY_SERVICE <-->|Data Plane API| DATAPLANE[HAProxy Data Plane API]
    DATAPLANE <--> CONFIG[HAProxy Configuration]
    CONFIG --> HAPROXY

    %% Agent registration
    AGENT[Agent VPS] --> REGISTER[Register]
    REGISTER --> AGENT_SERVICE[Agent Service]
    AGENT_SERVICE --> PROXY_SERVICE

    %% Styles
    classDef external fill:#ffd, stroke:#c80,stroke-width:1px;
    classDef internal fill:#ddf, stroke:#11f,stroke-width:1px;
    classDef config fill:#dfd, stroke:#080,stroke-width:1px;

    class CLIENT,ADMIN,AGENT,APP_SERVERS,DB_SERVERS external;
    class API_SERVER,PROXY_SERVICE,HAPROXY_SERVICE,AGENT_SERVICE internal;
    class DATAPLANE,CONFIG,BACKENDS config;
```

## Data Flow Explanation

### User Traffic Flow

1. **Client Request**:

   - A client makes a request to a subdomain (e.g., `app.cloudlunacy.uk` for HTTP or `mongodb.cloudlunacy.uk` for MongoDB)

2. **HAProxy Processing**:

   - The request reaches HAProxy frontends (HTTP or MongoDB)
   - HAProxy uses ACL rules to identify the correct backend based on the domain
   - The request is forwarded to the appropriate backend server

3. **Backend Response**:
   - The backend application or database server processes the request
   - The response flows back through HAProxy to the client

### Management Flow

1. **Administrator Actions**:

   - An administrator uses the API to manage routes

2. **API Processing**:

   - The API server validates the request and passes it to the Proxy Service
   - The Proxy Service coordinates with the HAProxy Service

3. **HAProxy Configuration**:
   - The HAProxy Service uses the Data Plane API to modify HAProxy configuration
   - Changes are applied to HAProxy without disrupting existing connections

### Agent Registration

1. **Agent Setup**:

   - A new Agent VPS registers itself with the CloudLunacy Front Server
   - The Agent Service validates the registration

2. **Route Creation**:
   - Upon successful registration, appropriate routes are created
   - The HAProxy configuration is updated to include the new agent's endpoints

## Key Concepts

| Concept        | Description                                       |
| -------------- | ------------------------------------------------- |
| Frontends      | HAProxy entry points that listen for requests     |
| ACLs           | Access Control Lists that determine routing rules |
| Backends       | Destination servers for forwarded requests        |
| Data Plane API | API for managing HAProxy configuration            |
| Agents         | Remote servers that register for routing          |
