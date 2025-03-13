#!/usr/bin/env node
/**
 * Check Imports Script
 *
 * This script scans all JavaScript files in the project and attempts to
 * require each imported module to identify any missing dependencies.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// Configuration
const ROOT_DIR = path.resolve(__dirname, "..");
const IGNORE_DIRS = ["node_modules", ".git", "logs"];
const EXTENSIONS = [".js"];

// Regular expression to match require statements
const REQUIRE_REGEX = /require\(['"]([^'"]+)['"]\)/g;
const IMPORT_REGEX = /import\s+.*?from\s+['"]([^'"]+)['"]/g;

// Track issues
const issues = [];

/**
 * Check if a module can be required
 */
function checkModule(modulePath, filePath) {
  try {
    // Skip node built-in modules
    if (!modulePath.startsWith(".") && !modulePath.startsWith("/")) {
      return true;
    }

    // Get absolute path for relative imports
    let absolutePath;
    if (modulePath.startsWith(".")) {
      absolutePath = path.resolve(path.dirname(filePath), modulePath);
    } else {
      absolutePath = modulePath;
    }

    // Try to resolve the module
    require.resolve(absolutePath);
    return true;
  } catch (err) {
    issues.push({
      file: filePath,
      module: modulePath,
      error: err.message,
    });
    return false;
  }
}

/**
 * Scan a file for imports
 */
function scanFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    let match;

    // Check require statements
    while ((match = REQUIRE_REGEX.exec(content)) !== null) {
      const modulePath = match[1];
      checkModule(modulePath, filePath);
    }

    // Check import statements
    while ((match = IMPORT_REGEX.exec(content)) !== null) {
      const modulePath = match[1];
      checkModule(modulePath, filePath);
    }
  } catch (err) {
    console.error(`Error scanning file ${filePath}: ${err.message}`);
  }
}

/**
 * Recursively scan a directory
 */
function scanDirectory(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    // Skip ignored directories
    if (entry.isDirectory() && !IGNORE_DIRS.includes(entry.name)) {
      scanDirectory(fullPath);
    }
    // Process JavaScript files
    else if (entry.isFile() && EXTENSIONS.includes(path.extname(entry.name))) {
      scanFile(fullPath);
    }
  }
}

// Main function
function main() {
  console.log("Scanning project for import issues...");
  scanDirectory(ROOT_DIR);

  if (issues.length === 0) {
    console.log("✅ No import issues found!");
    return;
  }

  console.log(`❌ Found ${issues.length} import issues:`);

  // Group issues by file
  const issuesByFile = {};
  for (const issue of issues) {
    if (!issuesByFile[issue.file]) {
      issuesByFile[issue.file] = [];
    }
    issuesByFile[issue.file].push(issue);
  }

  // Print issues
  for (const [file, fileIssues] of Object.entries(issuesByFile)) {
    console.log(`\nFile: ${path.relative(ROOT_DIR, file)}`);
    for (const issue of fileIssues) {
      console.log(`  - Cannot find module '${issue.module}'`);
    }
  }

  console.log("\nSuggested fixes:");
  console.log("1. Check if the module exists");
  console.log("2. Update import paths to match the project structure");
  console.log("3. Install missing npm packages if needed");
}

// Run the main function
main();
