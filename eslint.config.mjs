import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Lint configuration for the whole monorepo.
 *
 * The rules below are the ones that catch defects rather than style — Prettier
 * owns formatting, and `eslint-config-prettier` switches off every rule the two
 * would otherwise argue about. Type-aware linting is enabled because the rules
 * worth having here (floating promises, unsafe async) cannot work without it.
 */
export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "frontend/dist/**", "eslint.config.mjs", "**/*.tsbuildinfo"],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // A dedicated program that includes tests and the dashboard. The build
        // tsconfigs exclude both, and type-aware rules cannot lint a file that
        // is in no program.
        project: ["./tsconfig.lint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      // An unawaited promise is the most common way async code loses an error
      // silently, which matters more here than anywhere: a dropped rejection
      // in an agent run just looks like a run that never finished.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/require-await": "off",

      // The codebase deliberately has no `any`. Keep it that way.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",

      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-non-null-assertion": "warn",

      // `||` over `??` for strings is deliberate throughout: an unset env var
      // arrives as "" and must fall through to the default, which `??` would
      // not do. Keep the rule for other primitives, where `||` really is a bug
      // waiting to happen with 0 and false.
      "@typescript-eslint/prefer-nullish-coalescing": ["error", { ignorePrimitives: { string: true } }],

      "no-console": ["error", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
      "no-var": "error",
    },
  },

  // Tests assert against untyped JSON and use non-null assertions on fixtures
  // they control. Enforcing the strict type rules there produces noise, not
  // safety.
  {
    files: ["**/*.test.ts", "**/testing.ts", "**/*-contract.ts"],
    rules: {
      // node:test's test() returns a promise nobody is expected to await;
      // flagging every case buries the real findings.
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-console": "off",
    },
  },

  // Plain JavaScript tooling. Type-aware rules need a file to belong to a
  // TypeScript program, and these do not — but they should still be linted
  // rather than ignored, so the type-checked rules are switched off instead.
  {
    ...tseslint.configs.disableTypeChecked,
    files: ["**/*.mjs", "**/*.cjs", "**/*.js"],
    languageOptions: {
      parserOptions: { project: false },
      globals: { ...globals.node },
    },
  },

  // The dashboard runs in a browser, not Node.
  {
    files: ["frontend/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  prettier,
);
