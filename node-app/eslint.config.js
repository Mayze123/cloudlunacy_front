const globals = require("globals");
const js = require("@eslint/js");

module.exports = [
  // Apply to all JavaScript files
  {
    files: ["**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      ecmaVersion: 2022,
      globals: {
        ...globals.node,
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
    // Include recommended rules
    ...js.configs.recommended,
    // Custom rules
    rules: {
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_|^err|^next",
          varsIgnorePattern: "^_",
        },
      ],
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "always"],
      "no-multiple-empty-lines": ["error", { max: 2, maxEOF: 1 }],
      quotes: ["error", "double", { avoidEscape: true }],
      semi: ["error", "always"],
    },
  },
  // Specific overrides for test files if needed
  {
    files: ["**/*.test.js", "**/*.spec.js"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
  },
];
