#!/usr/bin/env node
/**
 * Dependency Checker
 *
 * This script checks all dependencies to identify which one might be causing
 * the "Unexpected token '{'" error.
 */

const fs = require("fs");
const path = require("path");

// Get the package.json
const packageJsonPath = path.join(process.cwd(), "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const dependencies = packageJson.dependencies || {};

console.log("Checking all dependencies...");

// Try to require each dependency
for (const dep in dependencies) {
  try {
    console.log(`Testing dependency: ${dep}`);
    require(dep);
    console.log(`✅ ${dep} loaded successfully`);
  } catch (err) {
    console.error(`❌ Error loading ${dep}: ${err.message}`);

    // If this is the error we're looking for
    if (err.message.includes("Unexpected token")) {
      console.error(`\n!!! FOUND PROBLEMATIC DEPENDENCY: ${dep} !!!`);
      console.error(`Error details: ${err.message}`);
      console.error(`This dependency is likely causing the startup issue.`);

      // Check if it's an ES module
      try {
        const depPackageJson = require(`${dep}/package.json`);
        if (depPackageJson.type === "module") {
          console.error(
            `${dep} is an ES module (type: "module" in package.json)`
          );
          console.error(
            `This is incompatible with CommonJS require() statements.`
          );
        }
      } catch (innerErr) {
        console.error(
          `Could not check if ${dep} is an ES module: ${innerErr.message}`
        );
      }
    }
  }
}

console.log("Dependency check complete.");
