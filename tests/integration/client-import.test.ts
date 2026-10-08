import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");

describe("server-only env module", () => {
  it("fails the Next.js build when imported by a Client Component", () => {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "node_modules/next/dist/bin/next"),
        "build",
        "tests/fixtures/client-import-app",
      ],
      { cwd: root, encoding: "utf8", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } },
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain("'server-only' cannot be imported from a Client Component module");
    expect(output).toContain("src/lib/env/server.ts");
  }, 180_000);
});
