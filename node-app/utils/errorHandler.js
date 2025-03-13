/**
 * Error Handler Utility
 *
 * Provides standardized error handling across the application.
 */

const logger = require("./logger");

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
  const appLogger = logger.getLogger("errorHandler");

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

module.exports = {
  AppError,
  asyncHandler,
  errorMiddleware,
};
