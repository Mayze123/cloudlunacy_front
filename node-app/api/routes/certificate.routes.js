/**
 * Certificate Routes
 *
 * Handles all certificate-related API endpoints including:
 * - Agent certificate generation and management
 * - Certificate validation
 * - Let's Encrypt certificate management
 * - Certificate metrics and monitoring
 */

const express = require("express");
const router = express.Router();
const { asyncHandler } = require("../../utils/errorHandler");
const certificateController = require("../controllers/certificateController");
const { requireRole } = require("../middleware/auth");

/**
 * Get MongoDB CA certificate
 *
 * GET /api/certificates/ca
 * Public endpoint, no authentication required
 */
router.get("/mongodb-ca", certificateController.getMongoCA);

/**
 * List all certificates in the system (public version)
 * Returns limited information without sensitive data
 *
 * GET /api/certificates/public
 * Public endpoint, no authentication required
 */
router.get(
  "/public",
  asyncHandler(certificateController.getPublicCertificateList)
);

/**
 * TEMPORARY: Force renewal of all certificates without auth
 * Remove this endpoint after testing is complete!
 *
 * GET /api/certificates/temp-renew-all
 * No authentication required - FOR DEVELOPMENT USE ONLY
 */
router.get(
  "/temp-renew-all",
  asyncHandler(async (req, res) => {
    try {
      const coreServices = require("../../services/core");
      const pathManager = require("../../utils/pathManager");
      const fs = require("fs").promises;
      const path = require("path");

      // Add debugging information to response
      const debugInfo = {
        certsPath: null,
        agentsPath: null,
        configPath: null,
        directories: {
          certs: null,
          agents: null,
          config: null,
        },
        foundCertificates: [],
        pathManagerInitialized: false,
        certificateServiceInitialized: false,
      };

      // Check path manager status
      if (pathManager.initialized) {
        debugInfo.pathManagerInitialized = true;
        debugInfo.certsPath = pathManager.getPath("certs");
        debugInfo.agentsPath = `${debugInfo.certsPath}/agents`;
        debugInfo.configPath = pathManager.getPath("config");
      }

      if (!coreServices.certificateService) {
        return res.status(500).json({
          success: false,
          message: "Certificate service not available",
          debugInfo,
        });
      }

      // Initialize if needed
      if (!coreServices.certificateService.initialized) {
        await coreServices.certificateService.initialize();
      }

      debugInfo.certificateServiceInitialized =
        coreServices.certificateService.initialized;

      // Check if directories exist and what they contain
      try {
        const certsDir = coreServices.certificateService.certsDir;
        debugInfo.certsPath = certsDir;

        const agentsDir = `${certsDir}/agents`;
        debugInfo.agentsPath = agentsDir;

        // List directories
        try {
          const certsDirContents = await fs.readdir(certsDir);
          debugInfo.directories.certs = certsDirContents;
        } catch (e) {
          debugInfo.directories.certs = `Error: ${e.message}`;
        }

        try {
          const agentsDirContents = await fs.readdir(agentsDir);
          debugInfo.directories.agents = agentsDirContents;
        } catch (e) {
          debugInfo.directories.agents = `Error: ${e.message}`;
        }
        
        // Look for certificates in other potential locations
        try {
          const configDir = process.env.CONFIG_DIR || "/app/config";
          debugInfo.configPath = configDir;
          
          const configDirContents = await fs.readdir(configDir);
          debugInfo.directories.config = configDirContents;
          
          // Check if there's an alternative agents directory
          if (configDirContents.includes('agents')) {
            const altAgentsPath = path.join(configDir, 'agents');
            const altAgentsDirContents = await fs.readdir(altAgentsPath);
            debugInfo.directories.altAgents = altAgentsDirContents;
            
            // Look for certificate files in agent directories
            for (const agentDir of altAgentsDirContents) {
              try {
                const agentPath = path.join(altAgentsPath, agentDir);
                const stat = await fs.stat(agentPath);
                
                if (stat.isDirectory()) {
                  const agentFiles = await fs.readdir(agentPath);
                  const hasCertFiles = agentFiles.some(file => 
                    file.endsWith('.crt') || file.endsWith('.key') || file.endsWith('.pem')
                  );
                  
                  if (hasCertFiles) {
                    debugInfo.foundCertificates.push({
                      agentId: agentDir,
                      path: agentPath,
                      files: agentFiles
                    });
                  }
                }
              } catch (err) {
                // Skip errors for individual agent directories
              }
            }
          }
          
          // Also check if certificates are stored in a flattened structure
          const configCertsPath = path.join(configDir, 'certs');
          if (configDirContents.includes('certs')) {
            try {
              const configCertsDirContents = await fs.readdir(configCertsPath);
              debugInfo.directories.configCerts = configCertsDirContents;
              
              // Check for certificate files in a flat structure
              const certFiles = configCertsDirContents.filter(file => 
                file.endsWith('.crt') || file.endsWith('.key') || file.endsWith('.pem')
              );
              
              // Group by prefix to identify agent certificates
              const agentPrefixMap = {};
              for (const file of certFiles) {
                if (file === 'ca.crt' || file === 'ca.key') continue;
                
                const match = file.match(/^([^\.]+)\.(?:crt|key|pem)$/);
                if (match) {
                  const prefix = match[1];
                  if (!agentPrefixMap[prefix]) {
                    agentPrefixMap[prefix] = [];
                  }
                  agentPrefixMap[prefix].push(file);
                }
              }
              
              // Add any identified agent certificates
              Object.keys(agentPrefixMap).forEach(prefix => {
                if (agentPrefixMap[prefix].length >= 2) { // Likely a cert+key pair
                  debugInfo.foundCertificates.push({
                    agentId: prefix,
                    path: configCertsPath,
                    files: agentPrefixMap[prefix]
                  });
                }
              });
            } catch (e) {
              debugInfo.directories.configCerts = `Error: ${e.message}`;
            }
          }
        } catch (e) {
          debugInfo.directories.config = `Error: ${e.message}`;
        }
      } catch (dirError) {
        debugInfo.directoryError = dirError.message;
      }

      // Try to find the expected directory structure
      debugInfo.serviceConfig = {
        certsDir: coreServices.certificateService.certsDir,
        useHaproxy: coreServices.certificateService.useHaproxy || false,
        caPath: coreServices.certificateService.caPath || null,
        caKeyPath: coreServices.certificateService.caKeyPath || null,
        autoRenew: coreServices.certificateService.autoRenew || false
      };

      const result =
        await coreServices.certificateService.checkAndRenewCertificates({
          forceRenewal: true,
          renewBeforeDays: 30,
        });

      return res.status(200).json({
        success: true,
        message: "Certificate operation completed",
        result,
        debugInfo,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: "Certificate operation failed",
        error: error.message,
      });
    }
  })
);

/**
 * Get certificate status
 *
 * GET /api/certificates/status
 * Requires admin role
 */
router.get("/status", requireRole("admin"), function (req, res) {
  // Explicitly define a handler function
  if (typeof certificateController.getCertificateStatus === "function") {
    return certificateController.getCertificateStatus(req, res);
  } else {
    return res.status(501).json({
      success: false,
      message: "Certificate status functionality not implemented yet",
    });
  }
});

/**
 * Get certificate metrics
 * Shows current metrics and trends
 *
 * GET /api/certificates/metrics
 * Requires admin role
 */
router.get("/metrics", requireRole("admin"), function (req, res) {
  // Explicitly define a handler function
  if (typeof certificateController.getCertificateMetrics === "function") {
    return certificateController.getCertificateMetrics(req, res);
  } else {
    return res.status(501).json({
      success: false,
      message: "Certificate metrics functionality not implemented yet",
    });
  }
});

/**
 * Get historical certificate metrics
 * Shows metrics history for a specific time range
 *
 * GET /api/certificates/metrics/history
 * Requires admin role
 */
router.get(
  "/metrics/history",
  requireRole("admin"),
  asyncHandler(certificateController.getMetricsHistory)
);

/**
 * List all certificates in the system
 *
 * GET /api/certificates
 * Requires admin role
 */
router.get(
  "/",
  requireRole("admin"),
  asyncHandler(certificateController.getAllCertificates)
);

/**
 * Trigger certificate renewal check
 *
 * POST /api/certificates/renew-check
 * Requires admin role
 */
router.post(
  "/renew-check",
  requireRole("admin"),
  asyncHandler(certificateController.runRenewalCheck)
);

/**
 * Get agent certificates
 *
 * GET /api/certificates/agent/:agentId
 * Requires authentication and agent access
 */
router.get(
  "/agent/:agentId",
  requireRole("admin"),
  asyncHandler(certificateController.getAgentCertificates)
);

/**
 * Regenerate agent certificate
 *
 * POST /api/certificates/agent/:agentId/regenerate
 * Requires authentication and agent access
 */
router.post(
  "/agent/:agentId/regenerate",
  requireRole("admin"),
  asyncHandler(certificateController.regenerateAgentCertificate)
);

/**
 * Validate agent certificate setup
 *
 * GET /api/certificates/agent/:agentId/validate
 * Requires authentication and agent access
 */
router.get(
  "/agent/:agentId/validate",
  requireRole("admin"),
  asyncHandler(certificateController.validateAgentCertificate)
);

/**
 * Issue or renew Let's Encrypt wildcard certificate
 *
 * POST /api/certificates/letsencrypt
 * Requires admin role
 */
router.post(
  "/letsencrypt",
  requireRole("admin"),
  asyncHandler(certificateController.issueLetsEncryptCert)
);

/**
 * Get certificate provider types
 *
 * GET /api/certificates/providers
 * Requires admin role
 */
router.get(
  "/providers",
  requireRole("admin"),
  asyncHandler(certificateController.getCertificateProviderTypes)
);

/**
 * Get certificate provider configuration
 *
 * GET /api/certificates/providers/:providerType/config
 * Requires admin role
 */
router.get(
  "/providers/:providerType/config",
  requireRole("admin"),
  asyncHandler(certificateController.getCertificateProviderConfig)
);

/**
 * Get certificate provider capabilities
 *
 * GET /api/certificates/provider/capabilities
 * Requires admin role
 */
router.get(
  "/provider/capabilities",
  requireRole("admin"),
  asyncHandler(certificateController.getCertificateProviderCapabilities)
);

/**
 * Validate certificate provider configuration
 *
 * GET /api/certificates/provider/validate
 * Requires admin role
 */
router.get(
  "/provider/validate",
  requireRole("admin"),
  asyncHandler(certificateController.validateCertificateProviderConfig)
);

module.exports = router;
