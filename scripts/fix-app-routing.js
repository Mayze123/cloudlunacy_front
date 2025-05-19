/**
 * Fix App Routing Script
 *
 * This script resolves issues with app routing in CloudLunacy Front.
 * It ensures that the required middleware and configuration exists in Consul KV store.
 */

// Import required modules
const ConsulService = require("../node-app/services/core/consulService");
const fs = require("fs");
const path = require("path");
const logger = require("../node-app/utils/logger").getLogger("fix-app-routing");

// Initialize Consul service
const consulService = new ConsulService();

// Main function
async function fixAppRouting() {
  try {
    console.log("Initializing Consul service...");
    await consulService.initialize();

    if (!consulService.isInitialized) {
      console.error("Failed to initialize Consul service");
      process.exit(1);
    }

    console.log("Checking Traefik configuration in Consul...");

    // 1. Check for app-routing middleware
    let appRoutingMiddleware = await consulService.get(
      "http/middlewares/app-routing"
    );
    if (!appRoutingMiddleware) {
      console.log("Creating app-routing middleware chain...");
      const middleware = {
        chain: {
          middlewares: ["secure-headers", "cors-headers", "compress"],
        },
      };
      await consulService.set("http/middlewares/app-routing", middleware);
      console.log("Created app-routing middleware chain");
    } else {
      console.log("App-routing middleware exists:", appRoutingMiddleware);
    }

    // 2. Check for the 'apps' router
    let appsRouter = await consulService.get("http/routers/apps");
    if (!appsRouter) {
      console.log("Creating apps router...");
      const router = {
        entryPoints: ["websecure"],
        rule: "HostRegexp(`{subdomain:[a-z0-9-]+}.apps.cloudlunacy.uk`)",
        service: "node-app-service",
        middlewares: ["app-routing"],
        tls: {
          certResolver: "letsencrypt",
        },
        priority: 100,
      };
      await consulService.set("http/routers/apps", router);
      console.log("Created apps router");
    } else {
      console.log("Apps router exists:", appsRouter);
    }

    // 3. Check for the node-app-service
    let nodeAppService = await consulService.get(
      "http/services/node-app-service"
    );
    if (!nodeAppService) {
      console.log("Creating node-app-service...");
      const service = {
        loadBalancer: {
          servers: [{ url: "http://node-app:3005" }],
        },
      };
      await consulService.set("http/services/node-app-service", service);
      console.log("Created node-app-service");
    } else {
      console.log("Node app service exists:", nodeAppService);
    }

    // 4. List all HTTP routers in Consul for verification
    const httpRouters = await consulService.get("http/routers");
    console.log("Current HTTP routers in Consul:");
    for (const [name, router] of Object.entries(httpRouters || {})) {
      console.log(
        `Router: ${name}, Service: ${router.service}, Rule: ${router.rule}`
      );

      // Check if this router is missing app-routing middleware but should have it
      if (
        name !== "http-catchall" &&
        name !== "traefik-healthcheck" &&
        name !== "dashboard" &&
        name !== "api" &&
        name !== "apps" &&
        (!router.middlewares || !router.middlewares.includes("app-routing"))
      ) {
        console.log(`Adding app-routing middleware to router ${name}`);
        router.middlewares = router.middlewares || [];
        if (!router.middlewares.includes("app-routing")) {
          router.middlewares.push("app-routing");
          await consulService.set(`http/routers/${name}`, router);
          console.log(`Updated router ${name} with app-routing middleware`);
        }
      }
    }

    // 5. Check if secure-headers middleware exists
    let secureHeadersMiddleware = await consulService.get(
      "http/middlewares/secure-headers"
    );
    if (!secureHeadersMiddleware) {
      console.log("Creating secure-headers middleware...");
      const middleware = {
        headers: {
          frameDeny: true,
          browserXssFilter: true,
          contentTypeNosniff: true,
          forceSTSHeader: true,
          stsIncludeSubdomains: true,
          stsPreload: true,
          stsSeconds: 31536000,
        },
      };
      await consulService.set("http/middlewares/secure-headers", middleware);
      console.log("Created secure-headers middleware");
    }

    console.log("App routing configuration fixed successfully!");
  } catch (error) {
    console.error("Error fixing app routing:", error);
    process.exit(1);
  }
}

// Run the fix
fixAppRouting();
