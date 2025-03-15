#!/usr/bin/env node
/**
 * Scan for Class-like Structure Issues
 *
 * This script scans JavaScript files for potential class-like structures
 * that might be causing issues.
 */

const fs = require("fs");
const path = require("path");

// Configuration
const ROOT_DIR = path.resolve(__dirname, "..");
const IGNORE_DIRS = ["node_modules", ".git", "logs"];
const EXTENSIONS = [".js"];

// Regular expressions to match potential issues
const METHOD_PATTERN = /^\s*(async\s+)?(\w+)\s*\(([^)]*)\)\s*{/gm;
const THIS_USAGE_PATTERN = /\bthis\.\w+/g;

// Track issues
const issues = [];

/**
 * Scan a file for potential issues
 */
function scanFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");

    // Check for method-like definitions and this usage
    const hasMethods = METHOD_PATTERN.test(content);
    const hasThisUsage = THIS_USAGE_PATTERN.test(content);

    // Reset regex lastIndex
    METHOD_PATTERN.lastIndex = 0;
    THIS_USAGE_PATTERN.lastIndex = 0;

    // If file has both method-like definitions and uses 'this', it might be a class-like structure
    if (hasMethods && hasThisUsage) {
      issues.push({
        file: filePath,
        hasMethods,
        hasThisUsage,
      });
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
  console.log("Scanning project for potential class-like structure issues...");
  scanDirectory(ROOT_DIR);

  if (issues.length === 0) {
    console.log("✅ No potential class-like structure issues found!");
    return;
  }

  console.log(
    `❌ Found ${issues.length} files with potential class-like structure issues:`
  );

  for (const issue of issues) {
    console.log(`\nFile: ${path.relative(ROOT_DIR, issue.file)}`);
    console.log(
      `  - Has method-like definitions: ${issue.hasMethods ? "Yes" : "No"}`
    );
    console.log(`  - Uses 'this': ${issue.hasThisUsage ? "Yes" : "No"}`);
  }

  console.log("\nPossible solutions:");
  console.log("1. Convert to proper class definition");
  console.log("2. Convert to object with methods");
  console.log("3. Convert to standalone functions and remove this usage");
}

// Run the main function
main();
