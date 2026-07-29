import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // Test doubles frequently type mock/spy properties as `Function` for brevity;
    // keep it visible as a warning instead of failing lint.
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-function-type": "warn",
    },
  },
  {
    ignores: ["dist/", "node_modules/"],
  }
);
