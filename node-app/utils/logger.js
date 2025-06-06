// utils/logger.js - Improved production-ready logger

const fs = require("fs");
const path = require("path");
const { createLogger, format, transports } = require("winston");
require("winston-daily-rotate-file");

class Logger {
  constructor() {
    // Define log directory - ensure it exists
    this.logDir = process.env.LOG_DIR || "/app/logs";
    this.ensureLogDirectory();

    // Create the base logger
    this.logger = this.createBaseLogger();

    // Component loggers cache
    this.componentLoggers = new Map();
  }

  ensureLogDirectory() {
    try {
      // First try to use the configured directory
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
        fs.chmodSync(this.logDir, 0o755);
        console.log(`Created log directory at ${this.logDir}`);
      }

      // Verify we can write to this directory
      const testFile = path.join(this.logDir, ".write_test");
      fs.writeFileSync(testFile, "test");
      fs.unlinkSync(testFile);
    } catch (err) {
      console.error(`Failed to use log directory at ${this.logDir}:`, err);

      // Try alternate locations in order of preference
      const alternateLocations = [
        "/app/logs",
        process.env.HOME ? path.join(process.env.HOME, "logs") : null,
        "/tmp/cloudlunacy-logs",
      ].filter(Boolean);

      let success = false;

      for (const altDir of alternateLocations) {
        if (altDir === this.logDir) continue; // Skip if same as original

        try {
          if (!fs.existsSync(altDir)) {
            fs.mkdirSync(altDir, { recursive: true });
          }

          // Verify we can write to this directory
          const testFile = path.join(altDir, ".write_test");
          fs.writeFileSync(testFile, "test");
          fs.unlinkSync(testFile);

          this.logDir = altDir;
          console.log(`Using alternate log directory: ${this.logDir}`);
          success = true;
          break;
        } catch (altErr) {
          console.error(
            `Failed to use alternate log directory ${altDir}:`,
            altErr
          );
        }
      }

      if (!success) {
        console.error(
          "CRITICAL: Couldn't find a writable log directory, logs will only be sent to console"
        );
        this.logsDisabled = true;
      }
    }
  }

  createBaseLogger() {
    // Custom format for structured logging
    const customFormat = format.combine(
      format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
      format.errors({ stack: true }),
      format.splat(),
      format.json()
    );

    // Human-readable format for console
    const consoleFormat = format.combine(
      format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
      format.colorize(),
      format.printf(({ level, message, timestamp, component, ...meta }) => {
        const componentStr = component ? `[${component}] ` : "";
        const metaStr =
          Object.keys(meta).length && meta.stack !== undefined
            ? `\n${meta.stack}`
            : Object.keys(meta).length && meta.error !== undefined
            ? `\n${meta.error}`
            : Object.keys(meta).length
            ? `\n${JSON.stringify(meta, null, 2)}`
            : "";

        return `${timestamp} [${level}] ${componentStr}${message}${metaStr}`;
      })
    );

    // Determine log level from environment
    const logLevel = process.env.LOG_LEVEL || "info";

    // Console transport
    const consoleTransport = new transports.Console({
      level: logLevel,
      format: consoleFormat,
      handleExceptions: true,
    });

    const allTransports = [consoleTransport];

    // Only add file transports if logging to files is enabled
    if (!this.logsDisabled) {
      // Rotating file transport for all logs
      const fileTransport = new transports.DailyRotateFile({
        level: logLevel,
        filename: path.join(this.logDir, "app-%DATE%.log"),
        datePattern: "YYYY-MM-DD",
        maxSize: "20m",
        maxFiles: "14d",
        format: customFormat,
      });

      // Error-specific transport with longer retention
      const errorTransport = new transports.DailyRotateFile({
        level: "error",
        filename: path.join(this.logDir, "error-%DATE%.log"),
        datePattern: "YYYY-MM-DD",
        maxSize: "20m",
        maxFiles: "30d",
        format: customFormat,
      });

      allTransports.push(fileTransport, errorTransport);
    }

    // Create the logger
    return createLogger({
      level: logLevel,
      format: customFormat,
      defaultMeta: { service: "cloudlunacy-front" },
      transports: allTransports,
      exitOnError: false,
    });
  }

  /**
   * Get a component-specific logger
   * @param {string} component The component name
   * @returns {object} Logger instance with component context
   */
  getLogger(component) {
    // Check if we already have a cached logger for this component
    if (this.componentLoggers.has(component)) {
      return this.componentLoggers.get(component);
    }

    // Create a new component logger
    const componentLogger = {
      error: (message, meta = {}) =>
        this.logger.error(message, this.addComponentMeta(component, meta)),
      warn: (message, meta = {}) =>
        this.logger.warn(message, this.addComponentMeta(component, meta)),
      info: (message, meta = {}) =>
        this.logger.info(message, this.addComponentMeta(component, meta)),
      debug: (message, meta = {}) =>
        this.logger.debug(message, this.addComponentMeta(component, meta)),
      verbose: (message, meta = {}) =>
        this.logger.verbose(message, this.addComponentMeta(component, meta)),
      // Alias for backward compatibility
      log: (message, meta = {}) =>
        this.logger.info(message, this.addComponentMeta(component, meta)),
    };

    // Cache the logger
    this.componentLoggers.set(component, componentLogger);

    return componentLogger;
  }

  /**
   * Add component metadata to log
   */
  addComponentMeta(component, meta) {
    return { component, ...meta };
  }

  /**
   * Direct logging methods for backward compatibility
   */
  error(message, meta = {}) {
    return this.logger.error(message, meta);
  }

  warn(message, meta = {}) {
    return this.logger.warn(message, meta);
  }

  info(message, meta = {}) {
    return this.logger.info(message, meta);
  }

  debug(message, meta = {}) {
    return this.logger.debug(message, meta);
  }

  verbose(message, meta = {}) {
    return this.logger.verbose(message, meta);
  }

  /**
   * Express-compatible logging stream
   */
  get stream() {
    return {
      write: (message) => {
        this.logger.info(message.trim(), { component: "express" });
      },
    };
  }
}

// Export a singleton instance
module.exports = new Logger();
