import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { measureRoute, overBudget } from "../../scripts/terminal-bundle-size.mjs";

/** A fake `next build` output: one root chunk and one route chunk of incompressible bytes. */
function fakeBuild(rootBytes: number, routeBytes: number) {
  const dir = mkdtempSync(path.join(tmpdir(), "terminal-bundle-"));
  mkdirSync(path.join(dir, "static", "chunks"), { recursive: true });
  mkdirSync(path.join(dir, "server", "app", "terminal"), { recursive: true });
  writeFileSync(path.join(dir, "static", "chunks", "root.js"), randomBytes(rootBytes));
  writeFileSync(path.join(dir, "static", "chunks", "page.js"), randomBytes(routeBytes));
  writeFileSync(
    path.join(dir, "build-manifest.json"),
    JSON.stringify({ rootMainFiles: ["static/chunks/root.js"], polyfillFiles: [] }),
  );
  writeFileSync(
    path.join(dir, "server", "app", "terminal", "page_client-reference-manifest.js"),
    `globalThis.__RSC_MANIFEST = {"chunks":["/_next/static/chunks/page.js"]};`,
  );
  return dir;
}

describe("terminal bundle budget", () => {
  it("adds the root files and the route's chunks", () => {
    const { files, totalBytes } = measureRoute({ buildDir: fakeBuild(10_000, 20_000) });
    expect(files).toHaveLength(2);
    expect(totalBytes).toBeGreaterThan(29_000);
  });

  it("passes under the budget and fails over it", () => {
    const { totalBytes } = measureRoute({ buildDir: fakeBuild(60 * 1024, 100 * 1024) });
    expect(overBudget(totalBytes, 150)).toBe(true);
    expect(overBudget(totalBytes, 200)).toBe(false);
  });

  it("the script exits non-zero when the budget is exceeded", () => {
    const script = path.resolve("scripts/terminal-bundle-size.mjs");
    const build = fakeBuild(1024, 1024);
    // The script reads ./.next, so run it from a directory that holds a fake one.
    const cwd = mkdtempSync(path.join(tmpdir(), "terminal-cwd-"));
    renameSync(build, path.join(cwd, ".next"));
    expect(() =>
      execFileSync("node", [script, "--budget-kb", "1"], { cwd, stdio: "pipe" }),
    ).toThrow();
    expect(() =>
      execFileSync("node", [script, "--budget-kb", "10"], { cwd, stdio: "pipe" }),
    ).not.toThrow();
  });
});
