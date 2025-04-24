const express = require("express");
const router = express.Router();
const mongodbController = require("../controllers/mongodbController");
const authMiddleware = require("../middleware/auth");

/**
 * @swagger
 * /api/mongodb/register:
 *   post:
 *     summary: Register an agent's MongoDB instance
 *     description: Registers a MongoDB instance for Traefik routing
 *     tags: [MongoDB]
 *     security:
 *       - agentAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - agentId
 *               - targetIp
 *             properties:
 *               agentId:
 *                 type: string
 *                 description: ID of the agent registering its MongoDB
 *               targetIp:
 *                 type: string
 *                 description: IP address of the MongoDB server
 *               targetPort:
 *                 type: number
 *                 description: Port number of the MongoDB server
 *                 default: 27017
 *               useTls:
 *                 type: boolean
 *                 description: Whether to use TLS for MongoDB connections
 *                 default: true
 *     responses:
 *       200:
 *         description: MongoDB successfully registered
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   description: Whether the registration was successful
 *                 message:
 *                   type: string
 *                   description: Success message
 *                 domain:
 *                   type: string
 *                   description: Domain name for accessing the MongoDB instance
 *                 connectionString:
 *                   type: string
 *                   description: Connection string template (with placeholder credentials)
 *                 targetIp:
 *                   type: string
 *                   description: Target IP address for the MongoDB instance
 *                 targetPort:
 *                   type: number
 *                   description: Target port for the MongoDB instance
 *                 tlsEnabled:
 *                   type: boolean
 *                   description: Whether TLS is enabled for this connection
 *                 connectionTestResult:
 *                   type: object
 *                   description: Optional test results if connectivity testing was performed
 *       400:
 *         description: Missing required parameters
 *       404:
 *         description: Agent not found
 *       500:
 *         description: Internal server error
 */
router.post(
  "/register",
  authMiddleware.requireAuth,
  mongodbController.registerMongoDB
);

/**
 * @swagger
 * /api/mongodb/test-register:
 *   post:
 *     summary: TEST ONLY - Register a MongoDB instance without authentication
 *     description: For testing purposes only - Registers a MongoDB instance without requiring authentication
 *     tags: [MongoDB, Testing]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - agentId
 *               - targetIp
 *             properties:
 *               agentId:
 *                 type: string
 *                 description: ID of the agent registering its MongoDB
 *                 example: "test-mongo-agent"
 *               targetIp:
 *                 type: string
 *                 description: IP address of the MongoDB server
 *                 example: "127.0.0.1"
 *               targetPort:
 *                 type: number
 *                 description: Port number of the MongoDB server
 *                 default: 27017
 *               useTls:
 *                 type: boolean
 *                 description: Whether to use TLS for MongoDB connections
 *                 default: false
 *     responses:
 *       200:
 *         description: MongoDB successfully registered
 *       400:
 *         description: Missing required parameters
 *       500:
 *         description: Internal server error
 */
router.post("/test-register", mongodbController.registerMongoDB);

/**
 * @swagger
 * /api/mongodb:
 *   get:
 *     summary: List all MongoDB subdomains
 *     description: Get a list of all registered MongoDB subdomains
 *     tags: [MongoDB]
 *     security:
 *       - agentAuth: []
 *     responses:
 *       200:
 *         description: List of MongoDB subdomains
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 count:
 *                   type: number
 *                   description: Number of MongoDB subdomains
 *                 subdomains:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       agentId:
 *                         type: string
 *                       targetAddress:
 *                         type: string
 *                       lastUpdated:
 *                         type: string
 *       500:
 *         description: Internal server error
 */
router.get("/", authMiddleware.requireAuth, mongodbController.listSubdomains);

/**
 * @swagger
 * /api/mongodb/{agentId}:
 *   delete:
 *     summary: Remove a MongoDB subdomain
 *     description: Removes the MongoDB routing for a specific agent
 *     tags: [MongoDB]
 *     security:
 *       - agentAuth: []
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the agent to remove MongoDB routing for
 *     responses:
 *       200:
 *         description: MongoDB subdomain removed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       404:
 *         description: Agent or MongoDB route not found
 *       500:
 *         description: Internal server error
 */
router.delete(
  "/:agentId",
  authMiddleware.requireAuth,
  authMiddleware.requireAgentAccess(),
  mongodbController.removeSubdomain
);

/**
 * @swagger
 * /api/mongodb/{agentId}/test:
 *   get:
 *     summary: Test MongoDB connectivity
 *     description: Tests the connectivity to an agent's MongoDB instance with comprehensive diagnostics
 *     tags: [MongoDB]
 *     security:
 *       - agentAuth: []
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the agent to test MongoDB connectivity
 *       - in: query
 *         name: targetIp
 *         schema:
 *           type: string
 *         description: Optional override to test connectivity to a different IP address
 *     responses:
 *       200:
 *         description: Test results returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 error:
 *                   type: string
 *                 direct:
 *                   type: object
 *                   description: Results of direct MongoDB connection test
 *                 proxy:
 *                   type: object
 *                   description: Results of connection through the proxy
 *                 diagnostics:
 *                   type: object
 *                   description: System diagnostics information
 *                 routing:
 *                   type: object
 *                   description: Routing configuration information
 *                 recommendations:
 *                   type: array
 *                   description: Automated recommendations based on test results
 *                   items:
 *                     type: string
 *       404:
 *         description: Agent not found
 *       500:
 *         description: Internal server error
 */
router.get(
  "/:agentId/test",
  authMiddleware.requireAuth,
  authMiddleware.requireAgentAccess(),
  mongodbController.testConnection
);

/**
 * @swagger
 * /api/mongodb/test/{agentId}:
 *   get:
 *     summary: TEST ONLY - Test MongoDB connectivity without authentication
 *     description: For testing purposes only - Tests connectivity to a MongoDB instance without requiring authentication
 *     tags: [MongoDB, Testing]
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the agent to test MongoDB connectivity
 *         example: "test-mongo-agent"
 *     responses:
 *       200:
 *         description: Test results returned
 *       404:
 *         description: Agent not found
 *       500:
 *         description: Internal server error
 */
router.get("/test/:agentId", mongodbController.testConnection);

/**
 * @swagger
 * /api/mongodb/{agentId}/connection-info:
 *   get:
 *     summary: Get MongoDB connection information
 *     description: Retrieves connection information for a registered MongoDB instance
 *     tags: [MongoDB]
 *     security:
 *       - agentAuth: []
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the agent to get connection info for
 *     responses:
 *       200:
 *         description: Connection information retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 connectionInfo:
 *                   type: object
 *                   properties:
 *                     domain:
 *                       type: string
 *                     host:
 *                       type: string
 *                     port:
 *                       type: number
 *                     useTls:
 *                       type: boolean
 *       404:
 *         description: Agent not found or no connection info available
 *       500:
 *         description: Internal server error
 */
router.get(
  "/:agentId/connection-info",
  authMiddleware.requireAuth,
  authMiddleware.requireAgentAccess(),
  mongodbController.getConnectionInfo
);

module.exports = router;
