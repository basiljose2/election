"use client";

import { useState } from "react";
// The same verifier the command line uses: plain ES modules with no network access.
import { verifyBundle } from "../../../tools/verifier/lib/bundle.mjs";
import { readZip } from "../../../tools/verifier/lib/zip.mjs";

interface Check {
  id: string;
  title: string;
  status: "pass" | "fail" | "skip";
  detail: string;
}
interface Report {
  ok: boolean;
  resultHash: string;
  checks: Check[];
  notes: string[];
}

const LABEL = { pass: "PASS", fail: "FAIL", skip: "SKIP" } as const;

/** Reads the chosen zip with the File API and verifies it locally. */
export function VerifierClient() {
  const [report, setReport] = useState<Report | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onFile(file: File | undefined) {
    setReport(null);
    setError(null);
    if (!file) return;
    try {
      setProgress("Reading the bundle");
      const files = await readZip(new Uint8Array(await file.arrayBuffer()));
      const result = (await verifyBundle(files, { onProgress: setProgress })) as Report;
      setReport(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The file could not be verified");
    } finally {
      setProgress(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm font-medium">
        Verification bundle (.zip)
        <input
          type="file"
          accept=".zip,application/zip"
          data-testid="bundle-file"
          onChange={(e) => void onFile(e.target.files?.[0])}
          className="text-base font-normal"
        />
      </label>

      {progress && (
        <p role="status" data-testid="verify-progress" className="text-sm">
          {progress}…
        </p>
      )}
      {error && (
        <p role="alert" data-testid="verify-error" className="text-sm text-red-700">
          {error}
        </p>
      )}

      {report && (
        <section aria-label="Verification report" data-testid="verify-report" data-ok={report.ok}>
          <h2 className="text-lg font-medium">
            {report.ok ? "All checks passed" : "Verification failed"}
          </h2>
          <p className="font-mono text-xs break-all">Result hash {report.resultHash}</p>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {report.checks.map((c) => (
              <li key={c.id} data-check={c.id} data-status={c.status}>
                <strong className={c.status === "fail" ? "text-red-700" : undefined}>
                  {LABEL[c.status]}
                </strong>{" "}
                {c.title}
                {c.detail && (
                  <span className="text-zinc-600 dark:text-zinc-400"> ({c.detail})</span>
                )}
              </li>
            ))}
          </ul>
          {report.notes.map((n) => (
            <p key={n} className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
              {n}
            </p>
          ))}
        </section>
      )}
    </div>
  );
}
