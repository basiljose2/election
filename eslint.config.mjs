import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "playwright-report/**",
    "test-results/**",
    "tests/fixtures/**/.next/**",
    "supabase/.temp/**",
  ]),
  // Casting code handles vote choices. Nothing there may write to the console (or anything
  // else that ends up in logs): use src/lib/log.ts, which keeps an allowlist of fields.
  {
    files: ["src/lib/votes/**/*.ts", "src/app/terminal/api/**/*.ts", "src/app/master/api/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-console": "error",
    },
  },
  // The Voting Terminal holds a voter's choices in memory only. Any browser storage under
  // /terminal could outlive the ballot, so the APIs are banned there outright.
  {
    files: ["src/app/terminal/**/*.{ts,tsx}"],
    ignores: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "no-restricted-globals": [
        "error",
        ...["localStorage", "sessionStorage", "indexedDB", "caches"].map((name) => ({
          name,
          message: "The Voting Terminal must not use browser storage: choices stay in memory only.",
        })),
      ],
      "no-restricted-properties": [
        "error",
        ...["window", "globalThis", "self"].flatMap((object) =>
          ["localStorage", "sessionStorage", "indexedDB", "caches"].map((property) => ({
            object,
            property,
            message:
              "The Voting Terminal must not use browser storage: choices stay in memory only.",
          })),
        ),
      ],
    },
  },
]);

export default eslintConfig;
