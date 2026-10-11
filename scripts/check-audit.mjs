/**
 * Dependency audit gate: fails when a PRODUCTION dependency has a known high or critical
 * vulnerability.
 *
 *   node scripts/check-audit.mjs                 runs `npm audit --omit=dev --json`
 *   node scripts/check-audit.mjs report.json     checks an existing report (used by tests)
 *
 * Development-only tooling is excluded on purpose: it never ships to the server or a kiosk,
 * and its advisories are reviewed with the ASVS checklist (docs/security/asvs.md) instead.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const BLOCKING = new Set(["high", "critical"]);

/**
 * @param {any} report an `npm audit --json` document
 * @returns {{ ok: boolean, blocking: Array<{ name: string, severity: string, titles: string[] }> }}
 */
export function evaluateAudit(report) {
  const blocking = [];
  for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
    if (!BLOCKING.has(vulnerability.severity)) continue;
    const titles = (vulnerability.via ?? [])
      .filter((via) => typeof via === "object")
      .map((via) => `${via.title} (${via.url})`);
    blocking.push({ name, severity: vulnerability.severity, titles });
  }
  return { ok: blocking.length === 0, blocking };
}

function loadReport(path) {
  if (path) return JSON.parse(readFileSync(path, "utf8"));
  try {
    return JSON.parse(
      execFileSync("npm", ["audit", "--omit=dev", "--json"], {
        encoding: "utf8",
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch (error) {
    // npm audit exits non-zero when it finds anything; the report is still on stdout.
    if (error.stdout) return JSON.parse(error.stdout);
    throw error;
  }
}

function main() {
  const result = evaluateAudit(loadReport(process.argv[2]));
  if (result.ok) {
    console.log("OK: no high or critical vulnerability in production dependencies");
    return 0;
  }
  for (const item of result.blocking) {
    console.error(`${item.severity.toUpperCase()}  ${item.name}`);
    for (const title of item.titles) console.error(`    ${title}`);
  }
  console.error(`FAIL: ${result.blocking.length} blocking vulnerable package(s)`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
