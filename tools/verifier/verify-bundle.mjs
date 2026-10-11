#!/usr/bin/env node
// Command-line verifier for Campus EVM verification bundles.
//
//   node verify-bundle.mjs <bundle.zip> [--json]     exit 0 = every check passed, 1 = a check failed
//
// It reads the zip from disk and checks it entirely offline with ./lib/bundle.mjs (the same
// file the browser verifier page loads).

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { verifyBundle } from "./lib/bundle.mjs";
import { readZip } from "./lib/zip.mjs";

export async function verifyZipFile(path, options) {
  const files = await readZip(new Uint8Array(readFileSync(path)));
  return verifyBundle(files, options);
}

async function main(argv) {
  const args = argv.slice(2);
  const asJson = args.includes("--json");
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: node verify-bundle.mjs <bundle.zip> [--json]");
    return 2;
  }
  let report;
  try {
    report = await verifyZipFile(file, {
      onProgress: asJson ? undefined : (m) => console.error(`  ${m}…`),
    });
  } catch (error) {
    console.error(`cannot verify ${file}: ${error.message}`);
    return 2;
  }
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Result hash ${report.resultHash}`);
    for (const c of report.checks) {
      const mark = c.status === "pass" ? "PASS" : c.status === "skip" ? "SKIP" : "FAIL";
      console.log(`${mark}  ${c.title}${c.detail ? `  (${c.detail})` : ""}`);
    }
    for (const note of report.notes) console.log(`NOTE  ${note}`);
    console.log(report.ok ? "\nALL CHECKS PASSED" : "\nVERIFICATION FAILED");
  }
  return report.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv);
}
