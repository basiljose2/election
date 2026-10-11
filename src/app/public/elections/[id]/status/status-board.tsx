"use client";

import { useEffect, useState } from "react";
import type { PublicStatus } from "@/lib/transparency/public-data";

/** Refresh period: the board is never more than ~20 s old (10 s poll + 10 s CDN cache). */
export const STATUS_REFRESH_MS = 10_000;

const STATE_LABEL: Record<string, string> = {
  setup: "Preparing",
  mock_poll: "Test run",
  mock_cleared: "Ready",
  open: "Polling open",
  closed: "Closed",
  sealed: "Closed",
};

/** Booth states and turnout totals only: no per-candidate data, no staff, no terminals. */
export function StatusBoard({ initial }: { initial: PublicStatus }) {
  const [status, setStatus] = useState(initial);

  useEffect(() => {
    let stopped = false;
    async function refresh() {
      try {
        const response = await fetch(`/public/api/elections/${initial.electionId}/status`);
        if (!response.ok || stopped) return;
        setStatus((await response.json()) as PublicStatus);
      } catch {
        // Offline: try again on the next tick.
      }
    }
    const timer = setInterval(refresh, STATUS_REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [initial.electionId]);

  return (
    <div className="flex flex-col gap-4" data-testid="status-board">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-md border border-zinc-300 p-3 dark:border-zinc-700">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Ballots cast</p>
          <p className="text-3xl font-semibold tabular-nums" data-testid="public-total-cast">
            {status.totals.ballotsCast}
          </p>
        </div>
        <div className="rounded-md border border-zinc-300 p-3 dark:border-zinc-700">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Ballots cancelled</p>
          <p className="text-3xl font-semibold tabular-nums">{status.totals.ballotsCancelled}</p>
        </div>
      </div>
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-zinc-300 dark:border-zinc-700">
            <th className="py-2">Booth</th>
            <th>State</th>
            <th className="text-right">Cast</th>
            <th className="text-right">Cancelled</th>
          </tr>
        </thead>
        <tbody>
          {status.booths.map((b) => (
            <tr
              key={b.boothId}
              className="border-b border-zinc-200 dark:border-zinc-800"
              data-testid={`public-booth-${b.boothId}`}
            >
              <td className="py-2">
                {b.name} <span className="text-zinc-600 dark:text-zinc-400">· {b.location}</span>
              </td>
              <td data-state={b.state}>{STATE_LABEL[b.state] ?? b.state}</td>
              <td className="text-right tabular-nums" data-testid={`public-cast-${b.boothId}`}>
                {b.ballotsCast}
              </td>
              <td className="text-right tabular-nums">{b.ballotsCancelled}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        Updated {new Date(status.generatedAt).toLocaleTimeString()}. This page refreshes itself.
      </p>
    </div>
  );
}
