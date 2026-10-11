"use client";

import { useEffect, useRef, useState } from "react";
import type { PollingDashboard } from "@/lib/results/polling-dashboard";
import { forceCloseAction } from "./actions";

/** How often the booth table refreshes (the requirement is within 10 seconds). */
export const DASHBOARD_REFRESH_MS = 5_000;

const STATE_LABEL: Record<string, string> = {
  setup: "Setup",
  mock_poll: "Mock poll",
  mock_cleared: "Mock cleared",
  open: "Open",
  closed: "Closed",
  sealed: "Sealed",
};

function ago(iso: string | null, now: number): string {
  if (!iso) return "no ballots yet";
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return new Date(iso).toLocaleTimeString();
}

const dot = (online: boolean) => (
  <span className={online ? "text-green-700" : "text-red-700"}>
    {online ? "online" : "offline"}
  </span>
);

/**
 * Booth rows and totals for the Returning Officer. The data is a plain JSON poll of
 * /api/elections/:id/dashboard every 5 seconds (totals and states only).
 */
export function LiveBooths({
  initial,
  canForceClose,
}: {
  initial: PollingDashboard;
  canForceClose: boolean;
}) {
  const [data, setData] = useState(initial);
  const [now, setNow] = useState(() => Date.parse(initial.generatedAt));
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    async function refresh() {
      try {
        const response = await fetch(`/api/elections/${initial.electionId}/dashboard`, {
          cache: "no-store",
        });
        if (!response.ok || stopped.current) return;
        const next = (await response.json()) as PollingDashboard;
        setData(next);
        setNow(Date.parse(next.generatedAt));
      } catch {
        // Offline: the next tick tries again.
      }
    }
    const timer = setInterval(refresh, DASHBOARD_REFRESH_MS);
    return () => {
      stopped.current = true;
      clearInterval(timer);
    };
  }, [initial.electionId]);

  const open = data.booths.filter((b) => b.state !== "closed" && b.state !== "sealed");

  return (
    <div className="flex flex-col gap-4" data-testid="live-booths">
      <section aria-label="Totals" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["Ballots cast", data.totals.ballotsCast, "total-cast"],
          ["Ballots cancelled", data.totals.ballotsCancelled, "total-cancelled"],
          ["Booths closed", `${data.totals.boothsClosed} / ${data.totals.booths}`, "total-closed"],
        ].map(([label, value, id]) => (
          <div key={id} className="rounded-md border border-zinc-300 p-3 dark:border-zinc-700">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">{label}</p>
            <p className="text-3xl font-semibold tabular-nums" data-testid={String(id)}>
              {value}
            </p>
          </div>
        ))}
      </section>

      <table className="w-full text-left text-sm" data-testid="booth-table">
        <thead>
          <tr className="border-b border-zinc-300 dark:border-zinc-700">
            <th className="py-2">Booth</th>
            <th>State</th>
            <th>Master</th>
            <th>Voting</th>
            <th className="text-right">Cast</th>
            <th className="text-right">Cancelled</th>
            <th>Last activity</th>
          </tr>
        </thead>
        <tbody>
          {data.booths.map((b) => (
            <tr
              key={b.boothId}
              data-testid={`booth-row-${b.boothId}`}
              className="border-b border-zinc-200 dark:border-zinc-800"
            >
              <td className="py-2 font-medium">{b.name}</td>
              <td data-state={b.state}>{STATE_LABEL[b.state] ?? b.state}</td>
              <td>{dot(b.masterOnline)}</td>
              <td>{dot(b.votingOnline)}</td>
              <td className="text-right tabular-nums" data-testid={`cast-${b.boothId}`}>
                {b.ballotsCast}
              </td>
              <td className="text-right tabular-nums">{b.ballotsCancelled}</td>
              <td>{ago(b.lastActivityAt, now)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {data.electionStatus === "polling_open" && (
        <section aria-label="Complete all polls" className="flex flex-col gap-3">
          <h2 className="text-lg font-medium">Before completing the polls</h2>
          {open.length === 0 ? (
            <p className="text-sm" data-testid="checklist-clear">
              Every booth is closed.
            </p>
          ) : (
            <ul className="flex flex-col gap-3" data-testid="checklist">
              {open.map((b) => (
                <li
                  key={b.boothId}
                  className="flex flex-wrap items-center gap-3 rounded-md border border-zinc-300 p-3 dark:border-zinc-700"
                >
                  <span className="font-medium">{b.name}</span>
                  <span className="text-sm text-zinc-600 dark:text-zinc-400">
                    is {STATE_LABEL[b.state] ?? b.state}, not Closed
                  </span>
                  {canForceClose && b.state === "open" && (
                    <form action={forceCloseAction} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="electionId" value={data.electionId} />
                      <input type="hidden" name="boothId" value={b.boothId} />
                      <input
                        name="reason"
                        required
                        minLength={3}
                        placeholder="Reason for closing"
                        aria-label={`Reason for force-closing ${b.name}`}
                        className="h-9 rounded-md border border-zinc-300 bg-transparent px-2 text-sm dark:border-zinc-700"
                      />
                      <button
                        type="submit"
                        className="h-9 rounded-md bg-red-700 px-3 text-sm font-medium text-white"
                      >
                        Force close {b.name}
                      </button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
