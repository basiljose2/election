/**
 * Size budget for the Voting Terminal's JavaScript.
 *
 *   node scripts/terminal-bundle-size.mjs [--budget-kb 150] [--route /terminal]
 *
 * Run after `next build`. It adds up the gzipped size of every script the browser must load for
 * the route up front: the framework's root files plus the route's own chunks (the nomodule
 * polyfill is not loaded by the browsers the kiosks run). Exits non-zero over budget.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export const DEFAULT_BUDGET_KB = 150;

/** Script URLs named by a route's client reference manifest. */
export function routeChunks(manifestText) {
  return [...manifestText.matchAll(/"(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]);
}

/**
 * @param {{ buildDir?: string, route?: string }} options
 * @returns {{ files: Array<{ file: string, gzipBytes: number }>, totalBytes: number }}
 */
export function measureRoute({ buildDir = ".next", route = "/terminal" } = {}) {
  const manifestPath = path.join(
    buildDir,
    "server",
    "app",
    ...route.split("/").filter(Boolean),
    "page_client-reference-manifest.js",
  );
  if (!existsSync(manifestPath)) {
    throw new Error(`No client manifest for ${route} at ${manifestPath}: run \`next build\` first`);
  }
  const build = JSON.parse(readFileSync(path.join(buildDir, "build-manifest.json"), "utf8"));
  const urls = new Set(routeChunks(readFileSync(manifestPath, "utf8")));
  for (const file of build.rootMainFiles ?? []) urls.add(`/_next/${file}`);

  const files = [];
  for (const url of [...urls].sort()) {
    const file = path.join(buildDir, url.replace(/^\/_next\//, ""));
    if (!existsSync(file)) continue;
    files.push({ file: url, gzipBytes: gzipSync(readFileSync(file)).length });
  }
  return { files, totalBytes: files.reduce((sum, f) => sum + f.gzipBytes, 0) };
}

export function overBudget(totalBytes, budgetKb) {
  return totalBytes > budgetKb * 1024;
}

function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : fallback;
  };
  const budgetKb = Number(option("--budget-kb", DEFAULT_BUDGET_KB));
  const route = option("--route", "/terminal");
  const { files, totalBytes } = measureRoute({ route });
  for (const f of files) console.log(`${String(f.gzipBytes).padStart(8)}  ${f.file}`);
  const kb = (totalBytes / 1024).toFixed(1);
  if (overBudget(totalBytes, budgetKb)) {
    console.error(`FAIL: ${route} loads ${kb} KB gzipped JS, over the ${budgetKb} KB budget`);
    process.exit(1);
  }
  console.log(`OK: ${route} loads ${kb} KB gzipped JS (budget ${budgetKb} KB)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
