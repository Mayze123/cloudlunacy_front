#!/usr/bin/env node
/**
 * Fix ESLint Errors
 *
 * This script automatically fixes common ESLint errors across the codebase:
 * 1. Adds missing globals to files
 * 2. Renames unused variables with underscore prefix
 * 3. Removes unused imports
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// Configuration
const ROOT_DIR = path.resolve(__dirname, "..");
const IGNORE_DIRS = ["node_modules", ".git", "logs"];
const EXTENSIONS = [".js"];

// Track changes
const changedFiles = [];

/**
 * Fix common ESLint errors in a file
 */
function fixFile(filePath) {
  console.log(`Fixing ${path.relative(ROOT_DIR, filePath)}`);

  try {
    let content = fs.readFileSync(filePath, "utf8");
    let modified = false;

    // 1. Add missing globals directive if needed
    if (
      content.includes("process.") ||
      content.includes("process.env") ||
      content.includes("__dirname") ||
      content.includes("Buffer.")
    ) {
      if (!content.includes("/* global") && !content.includes("/* eslint")) {
        const globals = [];

        if (content.includes("process.") || content.includes("process.env")) {
          globals.push("process");
        }

        if (content.includes("__dirname")) {
          globals.push("__dirname");
        }

        if (content.includes("Buffer.")) {
          globals.push("Buffer");
        }

        if (globals.length > 0) {
          const globalDirective = `/* global ${globals.join(", ")} */\n`;
          content = globalDirective + content;
          modified = true;
        }
      }
    }

    // 2. Fix unused variables (err -> _err)
    const unusedVarRegex =
      /\b(err|next|result|corrected|backupErr|tlsConnected|mongoDBPortExposed)\b(?!\s*=|\s*\.|\s*\(|\s*\)|\s*\?)/g;
    if (unusedVarRegex.test(content)) {
      content = content.replace(unusedVarRegex, (match) => {
        if (
          match === "err" ||
          match === "next" ||
          match === "result" ||
          match === "corrected" ||
          match === "backupErr" ||
          match === "tlsConnected" ||
          match === "mongoDBPortExposed"
        ) {
          return "_" + match;
        }
        return match;
      });
      modified = true;
    }

    // 3. Fix unused imports
    const importRegex =
      /const\s+([a-zA-Z0-9_]+)\s*=\s*require\(['"](.*)['"]\);?\s*(?!\s*[a-zA-Z0-9_.])/g;
    let match;
    const unusedImports = [];

    while ((match = importRegex.exec(content)) !== null) {
      const importName = match[1];
      const importPath = match[2];

      // Check if the import is used elsewhere in the file
      const usageRegex = new RegExp(
        `\\b${importName}\\b(?!\\s*=\\s*require)`,
        "g"
      );
      const usageMatches = content.match(usageRegex);

      if (!usageMatches || usageMatches.length <= 1) {
        unusedImports.push({
          name: importName,
          path: importPath,
          fullMatch: match[0],
        });
      }
    }

    // Remove unused imports
    for (const imp of unusedImports) {
      content = content.replace(
        imp.fullMatch,
        `// Removed unused: ${imp.name}\n`
      );
      modified = true;
    }

    // Save changes if modified
    if (modified) {
      fs.writeFileSync(filePath, content);
      changedFiles.push(path.relative(ROOT_DIR, filePath));
    }

    return modified;
  } catch (err) {
    console.error(`Error fixing ${filePath}: ${err.message}`);
    return false;
  }
}

/**
 * Scan a directory for JavaScript files
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
      fixFile(fullPath);
    }
  }
}

// Main function
function main() {
  console.log("Fixing ESLint errors across the codebase...");

  // Scan and fix files
  scanDirectory(ROOT_DIR);

  console.log(`\nFixed ${changedFiles.length} files:`);
  changedFiles.forEach((file) => console.log(`- ${file}`));

  console.log("\nRun ESLint again to check remaining issues:");
  console.log("npx eslint .");
}

// Run the main function
main();
