import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "react-hooks/exhaustive-deps": "off",
      "react-hooks/set-state-in-effect": "off",
      "no-var": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "prefer-const": "off",
      "react/no-unescaped-entities": "off",
      "@next/next/no-img-element": "off",
      "no-use-before-define": "off",
      "@typescript-eslint/no-use-before-define": "off",
      "react-hooks/rules-of-hooks": "off",
      "react-hooks/immutability": "off",
      "@typescript-eslint/no-loop-func": "off"
    }
  }
]);

export default eslintConfig;
