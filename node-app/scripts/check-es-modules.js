#!/usr/bin/env node
/**
 * Check for ES Module Syntax
 *
 * This script scans JavaScript files for ES module syntax (import/export)
 * that might cause issues in a CommonJS environment.
 */

const fs = require("fs");
const path = require("path");

// Configuration
const ROOT_DIR = path.resolve(__dirname, "..");
const IGNORE_DIRS = ["node_modules", ".git", "logs"];
const EXTENSIONS = [".js"];

// Regular expressions to match ES module syntax
const IMPORT_REGEX = /^\s*import\s+.*?from\s+['"][^'"]+['"]/m;
const EXPORT_REGEX =
  /^\s*export\s+(?:default\s+)?(?:const|let|var|function|class|{)/m;

// Track issues
const issues = [];

/**
 * Scan a file for ES module syntax
 */
function scanFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");

    if (IMPORT_REGEX.test(content) || EXPORT_REGEX.test(content)) {
      issues.push({
        file: filePath,
        hasImport: IMPORT_REGEX.test(content),
        hasExport: EXPORT_REGEX.test(content),
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
  console.log("Scanning project for ES module syntax...");
  scanDirectory(ROOT_DIR);

  if (issues.length === 0) {
    console.log("✅ No ES module syntax found!");
    return;
  }

  console.log(`❌ Found ${issues.length} files with ES module syntax:`);

  for (const issue of issues) {
    console.log(`\nFile: ${path.relative(ROOT_DIR, issue.file)}`);
    console.log(`  - Has import statements: ${issue.hasImport ? "Yes" : "No"}`);
    console.log(`  - Has export statements: ${issue.hasExport ? "Yes" : "No"}`);
  }

  console.log("\nPossible solutions:");
  console.log(
    "1. Convert ES module syntax to CommonJS (require/module.exports)"
  );
  console.log('2. Add "type": "module" to package.json to enable ES modules');
  console.log("3. Rename files to .mjs extension for ES modules");
}

// Run the main function
main();
