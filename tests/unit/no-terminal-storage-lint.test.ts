import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * The Voting Terminal keeps choices in memory only. ESLint bans every browser storage API under
 * /terminal; this proves the rule is in force there (and only there).
 */
async function ruleIds(filePath: string, code: string) {
  const eslint = new ESLint({ cwd: process.cwd() });
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.map((m) => m.ruleId);
}

describe("no browser storage under /terminal", () => {
  it.each([
    ["localStorage.setItem('a', 'b');", "bare localStorage"],
    ["sessionStorage.getItem('a');", "bare sessionStorage"],
    ["indexedDB.open('x');", "indexedDB"],
    ["window.localStorage.clear();", "window.localStorage"],
    ["globalThis.sessionStorage.clear();", "globalThis.sessionStorage"],
  ])(
    "rejects %s (%s)",
    async (code) => {
      const ids = await ruleIds("src/app/terminal/leak.ts", `export function leak() { ${code} }\n`);
      expect(ids.some((id) => id?.startsWith("no-restricted-"))).toBe(true);
    },
    60_000,
  );

  it("allows storage elsewhere (the rule is scoped to /terminal)", async () => {
    const ids = await ruleIds(
      "src/app/master/idle-lock.tsx",
      "export function ok() { sessionStorage.getItem('a'); }\n",
    );
    expect(ids.some((id) => id?.startsWith("no-restricted-"))).toBe(false);
  }, 60_000);
});
