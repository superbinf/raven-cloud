import tsParser from "@typescript-eslint/parser";

const correctnessRules = {
  "no-constant-condition": ["error", { checkLoops: false }],
  "no-debugger": "error",
  "no-dupe-keys": "error",
  "no-duplicate-case": "error",
  "no-self-assign": "error",
  "no-unreachable": "error",
  "no-unsafe-finally": "error",
  "no-useless-catch": "error",
  "valid-typeof": "error"
};

export default [
  { ignores: ["**/node_modules/**", "**/dist/**", "**/.runtime/**", "**/coverage/**"] },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    rules: correctnessRules
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true }, sourceType: "module" } },
    rules: correctnessRules
  }
];
