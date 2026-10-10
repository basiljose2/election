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
]);

export default eslintConfig;
