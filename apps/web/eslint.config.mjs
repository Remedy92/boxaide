import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // bodyHtml is raw unsanitised sender HTML and renders only through
      // HtmlBody's sandboxed frame, never through the React tree. An error,
      // not a warning, keeps that mechanical rather than remembered: the
      // sandbox is layer 2 of 4 and this rule is what stops markup skipping
      // straight past all four. Design: SECURITY.md, "HTML mail rendering"
      // (cited in the tree as §6.4.6).
      "react/no-danger": "error",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
