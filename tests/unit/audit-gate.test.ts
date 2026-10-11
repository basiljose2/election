import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateAudit } from "../../scripts/check-audit.mjs";

/** A report shaped like `npm audit --json`, with one known-vulnerable production package. */
const vulnerable = {
  vulnerabilities: {
    "left-pad": {
      name: "left-pad",
      severity: "high",
      via: [
        { title: "Prototype pollution", url: "https://example.test/advisory", severity: "high" },
      ],
    },
    "moderate-thing": { name: "moderate-thing", severity: "moderate", via: ["left-pad"] },
  },
};

describe("dependency audit gate", () => {
  it("blocks a high or critical vulnerability", () => {
    const result = evaluateAudit(vulnerable);
    expect(result.ok).toBe(false);
    expect(result.blocking).toEqual([
      expect.objectContaining({ name: "left-pad", severity: "high" }),
    ]);
    expect(evaluateAudit({ vulnerabilities: { x: { severity: "critical", via: [] } } }).ok).toBe(
      false,
    );
  });

  it("passes with nothing, or with only moderate and low findings", () => {
    expect(evaluateAudit({ vulnerabilities: {} }).ok).toBe(true);
    expect(
      evaluateAudit({
        vulnerabilities: { a: { severity: "moderate", via: [] }, b: { severity: "low", via: [] } },
      }).ok,
    ).toBe(true);
  });

  it("the script exits non-zero on the known-vulnerable fixture and zero on a clean one", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "audit-"));
    const bad = path.join(dir, "bad.json");
    const good = path.join(dir, "good.json");
    writeFileSync(bad, JSON.stringify(vulnerable));
    writeFileSync(good, JSON.stringify({ vulnerabilities: {} }));

    const script = path.resolve("scripts/check-audit.mjs");
    expect(() => execFileSync("node", [script, bad], { stdio: "pipe" })).toThrow();
    expect(() => execFileSync("node", [script, good], { stdio: "pipe" })).not.toThrow();
  });
});
