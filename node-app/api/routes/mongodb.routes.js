const express = require("express");
const router = express.Router();
const mongodbController = require("../controllers/mongodbController");
const authMiddleware = require("../middleware/auth");

/**
 * @swagger
 * /api/mongodb/register:
 *   post:
 *     summary: Register an agent's MongoDB instance with HAProxy
 *     description: Allows an agent to register its MongoDB instance for HAProxy routing
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
 * /api/mongodb/{agentId}/test:
 *   get:
 *     summary: Test MongoDB connectivity
 *     description: Tests the connectivity to an agent's MongoDB instance
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
 *     responses:
 *       200:
 *         description: Test results returned
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

// Other MongoDB-related routes
router.get(
  "/:agentId/connection-info",
  authMiddleware.requireAuth,
  authMiddleware.requireAgentAccess(),
  mongodbController.getConnectionInfo
);
router.post(
  "/:agentId/credentials",
  authMiddleware.requireAuth,
  authMiddleware.requireAgentAccess(),
  mongodbController.generateCredentials
);

module.exports = router;
