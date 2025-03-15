// utils/pathResolver.js
/**
 * Path Resolver Utility
 *
 * Provides consistent path resolution across the application
 */

const path = require("path");
const fs = require("fs").promises;
const logger = require("./logger").getLogger("pathResolver");

/**
 * Resolve a path based on environment and availability
 * @param {string} relativePath - The relative path to resolve
 * @param {Array<string>} basePaths - Potential base paths to check
 * @returns {Promise<string>} - The resolved absolute path
 */
async function resolvePath(relativePath, basePaths = []) {
  // Default base paths to check
  const defaultBasePaths = [
    process.env.APP_BASE_PATH || "/app",
    process.env.CONFIG_BASE_PATH || "/app/config",
    "/opt/cloudlunacy_front",
    "/opt/cloudlunacy_front/node-app",
    process.cwd(),
  ];

  // Combine with provided base paths
  const allBasePaths = [...basePaths, ...defaultBasePaths];

  // Try each base path
  for (const basePath of allBasePaths) {
    const fullPath = path.join(basePath, relativePath);
    try {
      await fs.access(fullPath);
      logger.debug(`Resolved path ${relativePath} to ${fullPath}`);
      return fullPath;
    } catch (err) {
      // Path doesn't exist or isn't accessible, try next
      continue;
    }
  }

  // If we get here, no valid path was found
  logger.warn(`Could not resolve path: ${relativePath}`);

  // Return the default path as fallback
  const defaultPath = path.join(defaultBasePaths[0], relativePath);
  logger.debug(`Using default path: ${defaultPath}`);
  return defaultPath;
}

/**
 * Ensure a directory exists, creating it if necessary
 * @param {string} dirPath - The directory path to ensure
 * @returns {Promise<boolean>} - True if directory exists or was created
 */
async function ensureDirectory(dirPath) {
  try {
    await fs.access(dirPath);
    return true;
  } catch (err) {
    try {
      await fs.mkdir(dirPath, { recursive: true });
      logger.info(`Created directory: ${dirPath}`);
      return true;
    } catch (mkdirErr) {
      logger.error(
        `Failed to create directory ${dirPath}: ${mkdirErr.message}`
      );
      return false;
    }
  }
}

/**
 * Check if a path is writable
 * @param {string} filePath - The path to check
 * @returns {Promise<boolean>} - True if path is writable
 */
async function isWritable(filePath) {
  try {
    // Try to write a temporary file
    const testPath = path.join(
      path.dirname(filePath),
      `.write-test-${Date.now()}`
    );
    await fs.writeFile(testPath, "test");
    await fs.unlink(testPath);
    return true;
  } catch (err) {
    logger.warn(`Path ${filePath} is not writable: ${err.message}`);
    return false;
  }
}

module.exports = {
  resolvePath,
  ensureDirectory,
  isWritable,
};
