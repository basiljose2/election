import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
  // Next.js resolves `server-only` at build time (tests/integration/client-import.test.ts
  // covers that). Under Vitest the code runs on the server, so the marker is a no-op.
  "server-only": fileURLToPath(new URL("./tests/support/server-only-stub.ts", import.meta.url)),
};

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts", "tests/unit/**/*.test.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          setupFiles: ["tests/support/load-env.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
