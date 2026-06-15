import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import ts from "typescript-eslint";

export default defineConfig(
  {
    ignores: ["coverage/**", "dist/**", "node_modules/**", ".direnv/**", ".vite/**", ".vitest/**"],
  },
  js.configs.recommended,
  ts.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["tests/**/*.types.ts"],
    rules: {
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
);
