/**
 * Error Handler Utility
 *
 * Provides standardized error handling across the application.
 */

const logger = require("./logger").getLogger("errorHandler");
const pathManager = require("./pathManager");

/**
 * Custom error class with status code
 */
class AppError extends Error {
  constructor(message, statusCode = 500, details = {}) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = true; // Indicates if this is an operational error

    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Async handler to catch errors in async route handlers
 */
const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

/**
 * Global error handler middleware
 */
const errorMiddleware = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  const message = err.message || "Internal Server Error";
  const appLogger = logger;

  // Log the error
  if (statusCode >= 500) {
    appLogger.error(`${statusCode} - ${message}`, {
      error: err.message,
      stack: err.stack,
      path: req.path,
      method: req.method,
      ip: req.ip,
      details: err.details,
    });
  } else {
    appLogger.warn(`${statusCode} - ${message}`, {
      path: req.path,
      method: req.method,
      ip: req.ip,
      details: err.details,
    });
  }

  // Send response
  res.status(statusCode).json({
    success: false,
    error: message,
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
    ...(err.details && { details: err.details }),
  });
};

/**
 * Log error to file
 * @param {Error} err - Error to log
 * @returns {Promise<void>}
 */
async function logErrorToFile(err) {
  try {
    const fs = require("fs").promises;
    const errorLogPath = pathManager.resolvePath("logs", "errors.log");

    // Ensure directory exists
    await pathManager.ensureDirectory(pathManager.getPath("logs"));

    // Format error message
    const errorMessage = `[${new Date().toISOString()}] ${
      err.stack || err.message
    }\n`;

    // Append to log file
    await fs.appendFile(errorLogPath, errorMessage);
  } catch (logErr) {
    logger.error(`Failed to log error to file: ${logErr.message}`);
  }
}

module.exports = {
  AppError,
  asyncHandler,
  errorMiddleware,
  logErrorToFile,
};
