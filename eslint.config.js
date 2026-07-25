import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["node_modules", ".wrangler"] },

  {
    files: ["src/**/*.ts", "scripts/**/*.ts"],
    extends: [
      js.configs.recommended,
      // Type-aware: the Epic payload handling in epic.ts leans on optional
      // chaining and nullable types, and only the typed rules can see that.
      ...tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Epic's feed is untrusted input. AGENTS.md asks for defensive types
      // over `!` and `as`, so make the shortcuts an error rather than a habit.
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // `scheduled` is async because ExportedHandler declares it that way, and
      // it hands work to ctx.waitUntil instead of awaiting so the Worker isn't
      // held open. Dropping `async` to satisfy this rule fights the platform.
      "@typescript-eslint/require-await": "off",

      // `doFetch: typeof fetch` picks up the DOM `fetch` (returns `any`), not
      // the Workers one, so the rule reads the `as` in epic.ts as redundant.
      // It isn't: Response.json() is `unknown` and the assertion narrows it.
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
    },
  },

  {
    // no-non-null-assertion exists for Epic's untrusted payload in src/. The
    // build scripts index into locally-defined constant arrays with values
    // that are provably in range (WEEKDAYS[getUTCDay()]), where the `!` is
    // working around noUncheckedIndexedAccess rather than papering over an
    // unchecked API response.
    files: ["scripts/**/*.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },

  // Must stay last: turns off the stylistic rules Prettier owns.
  prettier,
);
