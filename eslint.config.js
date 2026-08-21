import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

/**
 * Linting is here to catch mistakes, not to enforce a house style.
 *
 * The rules below are the ones that find real bugs -- an unused variable that
 * marks a half-finished edit, a promise nobody waits for, a React hook called
 * conditionally. Anything purely cosmetic is left off deliberately: turning it
 * on would mean reformatting the whole codebase in one commit, which buries
 * every real change in noise and makes the history hard to read.
 *
 * Type-aware linting is also left off. It needs a full TypeScript program per
 * run, which is slow, and `npm run check` already does that job properly.
 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "build/**",
      "node_modules/**",
      ".cache/**",
      ".local/**",
      ".agents/**",
      "migrations/**",
      "attached_assets/**",
      "uploads/**",
      "client/public/**",
      "coverage/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ── Server, shared code and build configuration ────────────────────────────
  {
    files: ["server/**/*.ts", "shared/**/*.ts", "scripts/**/*.ts", "*.config.ts", "*.config.js"],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
    rules: {
      // Route handlers are typed `req: any` on purpose -- Express's own types
      // do not carry the session shape Passport attaches at runtime.
      "@typescript-eslint/no-explicit-any": "off",
      // A floating promise in a request handler is a hung request, so this one
      // would be worth having; it needs type information, which is why the
      // equivalent protection lives in the tests instead.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // `catch {}` is used deliberately where a failure is genuinely not
      // interesting -- parsing an optional URL, for instance.
      "no-empty": ["error", { allowEmptyCatch: true }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": "off",
    },
  },

  // ── React client ───────────────────────────────────────────────────────────
  {
    files: ["client/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // The rules that catch genuine breakage stay as errors: calling hooks
      // conditionally really does crash a page once a query resolves and the
      // hook count changes between renders.
      "react-hooks/rules-of-hooks": "error",

      // These four come from the React Compiler and flag performance and
      // purity concerns rather than bugs. Several fire inside the vendored
      // shadcn/ui components, which are upstream code we do not hand-edit, so
      // they are advisory here: visible in the output, not a build failure.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/incompatible-library": "warn",
      "react-hooks/purity": "warn",

      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },

  // ── Build configuration ────────────────────────────────────────────────────
  {
    files: ["*.config.ts", "*.config.js", "postcss.config.js"],
    rules: {
      // Tailwind's own documentation loads plugins with require(), and its
      // config is read by tooling that does not always go through the ESM
      // loader. Rewriting it to imports is a portability risk for no gain.
      "@typescript-eslint/no-require-imports": "off",
    },
  },

  // ── Tests ──────────────────────────────────────────────────────────────────
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/__tests__/**"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      // Tests deliberately construct malformed values to prove they are
      // rejected, which needs casts the production rules would flag.
      "@typescript-eslint/no-unsafe-function-type": "off",
    },
  },
);
