/**
 * Exec Utility
 *
 * Provides promisified and enhanced shell command execution
 * with error handling and timeouts.
 */

const { exec, execFile } = require("child_process");
const { promisify } = require("util");

// Promisify the exec function
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Execute a shell command with timeout and error handling
 *
 * @param {string} command - The command to execute
 * @param {Object} options - Options for execution
 * @param {number} options.timeout - Timeout in milliseconds (default: 30000)
 * @returns {Promise<{stdout: string, stderr: string}>} - Command output
 */
async function executeCommand(command, options = {}) {
  const timeout = options.timeout || 30000; // Default 30s timeout

  try {
    // Add timeout option
    const execOptions = {
      ...options,
      timeout,
    };

    const { stdout, stderr } = await execAsync(command, execOptions);

    return {
      success: true,
      stdout,
      stderr,
      command,
    };
  } catch (err) {
    // Check for timeout
    if (err.signal === "SIGTERM" && err.killed) {
      return {
        success: false,
        error: `Command timed out after ${timeout}ms`,
        command,
        timeout: true,
      };
    }

    return {
      success: false,
      error: err.message,
      code: err.code,
      command,
      stderr: err.stderr,
      stdout: err.stdout,
    };
  }
}

/**
 * Execute a file with timeout and error handling
 *
 * @param {string} file - The file to execute
 * @param {string[]} args - Arguments for the file
 * @param {Object} options - Options for execution
 * @param {number} options.timeout - Timeout in milliseconds (default: 30000)
 * @returns {Promise<{stdout: string, stderr: string}>} - Command output
 */
async function executeFile(file, args = [], options = {}) {
  const timeout = options.timeout || 30000; // Default 30s timeout

  try {
    // Add timeout option
    const execOptions = {
      ...options,
      timeout,
    };

    const { stdout, stderr } = await execFileAsync(file, args, execOptions);

    return {
      success: true,
      stdout,
      stderr,
      file,
      args,
    };
  } catch (err) {
    // Check for timeout
    if (err.signal === "SIGTERM" && err.killed) {
      return {
        success: false,
        error: `Command timed out after ${timeout}ms`,
        file,
        args,
        timeout: true,
      };
    }

    return {
      success: false,
      error: err.message,
      code: err.code,
      file,
      args,
      stderr: err.stderr,
      stdout: err.stdout,
    };
  }
}

module.exports = {
  execAsync,
  execFileAsync,
  executeCommand,
  executeFile,
};
