module.exports = {
  env: {
    node: true,
    es6: true,
  },
  globals: {
    process: "readonly",
    Buffer: "readonly",
    __dirname: "readonly",
  },
  rules: {
    "no-unused-vars": [
      "error",
      {
        argsIgnorePattern: "^_|^err|^next",
        varsIgnorePattern: "^_",
      },
    ],
  },
};
