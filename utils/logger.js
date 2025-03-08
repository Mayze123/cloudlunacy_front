// utils/logger.js

/**
 * Logger Utility for CloudLunacy Front Server
 *
 * Provides consistent logging across the front server components
 * Features:
 * - Multiple log levels (error, warn, info, debug)
 * - Timestamps
 * - Component-based logging
 * - File and console output
 * - Log rotation
 */

const fs = require("fs");
const path = require("path");
const { createLogger, format, transports } = require("winston");
require("winston-daily-rotate-file");

// Define log directory - ensure it exists
const logDir = process.env.LOG_DIR || "/opt/cloudlunacy_front/logs";
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Create custom format
const customFormat = format.combine(
  format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
  format.errors({ stack: true }),
  format.splat(),
  format.printf(({ level, message, timestamp, component, ...meta }) => {
    const componentStr = component ? `[${component}] ` : "";
    const metaStr = Object.keys(meta).length
      ? `\n${JSON.stringify(meta, null, 2)}`
      : "";

    return `${timestamp} [${level.toUpperCase()}] ${componentStr}${message}${metaStr}`;
  })
);

// Create transports
const consoleTransport = new transports.Console({
  format: format.combine(format.colorize(), customFormat),
});

// Create file transport with rotation
const fileTransport = new transports.DailyRotateFile({
  filename: path.join(logDir, "front-%DATE%.log"),
  datePattern: "YYYY-MM-DD",
  maxSize: "20m",
  maxFiles: "14d",
  format: customFormat,
});

// Create error-specific transport
const errorTransport = new transports.DailyRotateFile({
  filename: path.join(logDir, "error-%DATE%.log"),
  datePattern: "YYYY-MM-DD",
  maxSize: "20m",
  maxFiles: "30d",
  level: "error",
  format: customFormat,
});

// Determine log level from environment variable
const logLevel = process.env.LOG_LEVEL || "info";

// Create the logger
const logger = createLogger({
  level: logLevel,
  format: customFormat,
  transports: [consoleTransport, fileTransport, errorTransport],
  exitOnError: false,
});

/**
 * Get a component-specific logger
 * @param {string} component The component name
 * @returns {object} Logger instance with component context
 */
function getComponentLogger(component) {
  return {
    error: (message, meta = {}) =>
      logger.error(message, { component, ...meta }),
    warn: (message, meta = {}) => logger.warn(message, { component, ...meta }),
    info: (message, meta = {}) => logger.info(message, { component, ...meta }),
    debug: (message, meta = {}) =>
      logger.debug(message, { component, ...meta }),
    // Alias for backward compatibility
    log: (message, meta = {}) => logger.info(message, { component, ...meta }),
  };
}

// Export functions
module.exports = {
  // Get a component-specific logger
  getLogger: (component) => getComponentLogger(component),

  // Direct logger methods for backward compatibility and general use
  error: (message, meta = {}) => logger.error(message, meta),
  warn: (message, meta = {}) => logger.warn(message, meta),
  info: (message, meta = {}) => logger.info(message, meta),
  debug: (message, meta = {}) => logger.debug(message, meta),

  // Stream for Express logger middleware
  stream: {
    write: (message) => {
      logger.info(message.trim(), { component: "express" });
    },
  },
};
