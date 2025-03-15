#!/usr/bin/env node
/**
 * Fix Syntax Error in configManager.js
 *
 * This script identifies and fixes the syntax error in configManager.js
 */

const fs = require("fs");
const path = require("path");

// Path to the file with the error
const configManagerPath = path.resolve(
  __dirname,
  "../services/core/configManager.js"
);

// Check if file exists
if (!fs.existsSync(configManagerPath)) {
  console.error(`File not found: ${configManagerPath}`);
  process.exit(1);
}

// Read the file
let content;
try {
  content = fs.readFileSync(configManagerPath, "utf8");
  console.log(`Successfully read ${configManagerPath}`);
} catch (err) {
  console.error(`Error reading file: ${err.message}`);
  process.exit(1);
}

// Look for the problematic pattern - now including async methods
const methodPattern = /(async\s+)?(\w+)\s*\(([^)]*)\)\s*{/g;
let matches = [];
let match;

while ((match = methodPattern.exec(content)) !== null) {
  // Check if this is a standalone method definition (not inside a class or object)
  const beforeMatch = content.substring(0, match.index).trim();
  const lastChar =
    beforeMatch.length > 0 ? beforeMatch[beforeMatch.length - 1] : "";

  // If the last character before the method is not '{', '=', or ':', it might be a standalone method
  if (
    lastChar !== "{" &&
    lastChar !== "=" &&
    lastChar !== ":" &&
    lastChar !== ","
  ) {
    matches.push({
      fullMatch: match[0],
      isAsync: !!match[1],
      methodName: match[2],
      params: match[3],
      index: match.index,
    });
  }
}

if (matches.length === 0) {
  console.log(
    "No problematic method definitions found. The issue might be elsewhere."
  );
  process.exit(0);
}

console.log(`Found ${matches.length} potential issues:`);
matches.forEach((m, i) => {
  console.log(
    `${i + 1}. ${m.isAsync ? "async " : ""}${m.methodName}(${
      m.params
    }) at position ${m.index}`
  );
});

// Fix the issues
let fixedContent = content;
let offset = 0;

matches.forEach((m) => {
  // Create the fixed version (convert to proper function declaration)
  const original = m.fullMatch;
  const fixed = `${m.isAsync ? "async " : ""}function ${m.methodName}(${
    m.params
  }) {`;

  // Replace in the content with offset adjustment
  const position = m.index + offset;
  fixedContent =
    fixedContent.substring(0, position) +
    fixed +
    fixedContent.substring(position + original.length);

  // Update offset for subsequent replacements
  offset += fixed.length - original.length;
});

// Write the fixed content back to the file
try {
  // Create a backup first
  fs.writeFileSync(`${configManagerPath}.bak`, content);
  console.log(`Created backup at ${configManagerPath}.bak`);

  // Write the fixed file
  fs.writeFileSync(configManagerPath, fixedContent);
  console.log(`Successfully fixed ${configManagerPath}`);
} catch (err) {
  console.error(`Error writing file: ${err.message}`);
  process.exit(1);
}

console.log(
  "Done! Please restart your application to see if the issue is resolved."
);
