import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * Casting code must not write to the console: log lines are the one place a choice could leak
 * to infrastructure. The ESLint config forbids console.* there; this test proves the rule is
 * actually in force for the casting modules and routes (and only there).
 */
async function messages(filePath: string, code: string) {
  const eslint = new ESLint({ cwd: process.cwd() });
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.map((m) => m.ruleId);
}

describe("no console.* in casting code", () => {
  const code = "export function leak(choice: string) { console.log(choice); }\n";

  it.each([
    "src/lib/votes/leak.ts",
    "src/app/terminal/api/cast/leak.ts",
    "src/app/master/api/mock-counts/leak.ts",
  ])(
    "rejects console.log in %s",
    async (file) => {
      expect(await messages(file, code)).toContain("no-console");
    },
    60_000,
  );

  it("allows it elsewhere (the rule is scoped to casting code)", async () => {
    expect(await messages("src/lib/audit/leak.ts", code)).not.toContain("no-console");
  }, 60_000);
});
