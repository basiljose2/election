"use client";

import { useRef, useState } from "react";
import type { ConnectionMode } from "@/lib/signals/use-terminal-state";
import type { MasterTerminalState } from "@/lib/terminals/state";

export type MasterState = MasterTerminalState;

export function actionOf(state: MasterState, action: string) {
  return state.allowedActions.find((a) => a.action === action) ?? null;
}

const BOOTH_STATE_LABEL: Record<string, string> = {
  setup: "Setup",
  mock_poll: "Mock poll",
  mock_cleared: "Mock poll cleared",
  open: "Poll open",
  closed: "Poll closed",
  sealed: "Sealed",
};

export function BoothHeader({ state }: { state: MasterState }) {
  return (
    <header className="flex flex-wrap items-baseline justify-between gap-2">
      <div>
        <p className="text-sm text-zinc-400" data-testid="election-name">
          {state.electionName}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight" data-testid="booth-name">
          {state.boothName}
        </h1>
      </div>
      <p
        className="rounded-md bg-zinc-700 px-3 py-1 text-sm font-medium uppercase tracking-wide"
        data-testid="booth-state"
        data-state={state.boothState}
      >
        {BOOTH_STATE_LABEL[state.boothState] ?? state.boothState}
      </p>
    </header>
  );
}

const CONNECTION_LABEL: Record<ConnectionMode, string> = {
  realtime: "Real-time",
  polling: "Polling (real-time unavailable)",
  connecting: "Connecting…",
};

export function TerminalStatus({ state, mode }: { state: MasterState; mode: ConnectionMode }) {
  const vt = state.votingTerminal;
  return (
    <section
      aria-label="Terminal status"
      className="flex flex-col gap-1 rounded-lg bg-zinc-900 px-4 py-3 text-sm"
    >
      <p data-testid="master-connection">
        Connection: <strong>{CONNECTION_LABEL[mode]}</strong>
      </p>
      <p data-testid="voting-terminal-status">
        Voting Terminal:{" "}
        {!vt.paired ? (
          <strong>not paired</strong>
        ) : (
          <>
            <strong
              data-testid="voting-terminal-online"
              className={vt.online ? "text-green-400" : "text-red-400"}
            >
              {vt.online ? "online" : "offline"}
            </strong>
            {vt.deviceId && ` (device ${vt.deviceId})`}
            {vt.lastSeenAgoMs !== null && (
              <span data-testid="voting-terminal-heartbeat">
                {" "}
                · last heartbeat {Math.round(vt.lastSeenAgoMs / 1000)} s ago
              </span>
            )}
          </>
        )}
      </p>
    </section>
  );
}

export function Counters({ state }: { state: MasterState }) {
  const mock = state.boothState === "mock_poll";
  const cast = mock ? state.mock.ballotsCast : state.ballotsCast;
  const cancelled = mock ? state.mock.ballotsCancelled : state.ballotsCancelled;
  return (
    <section aria-label="Counts" className="grid grid-cols-2 gap-4" data-mock={mock}>
      <div className="rounded-lg bg-zinc-900 p-4">
        <p className="text-sm text-zinc-400">{mock ? "Mock ballots cast" : "Ballots cast"}</p>
        <p className="font-mono text-6xl tabular-nums" data-testid="count-cast">
          {cast}
        </p>
      </div>
      <div className="rounded-lg bg-zinc-900 p-4">
        <p className="text-sm text-zinc-400">
          {mock ? "Mock ballots cancelled" : "Ballots cancelled"}
        </p>
        <p className="font-mono text-6xl tabular-nums" data-testid="count-cancelled">
          {cancelled}
        </p>
      </div>
    </section>
  );
}

function Lamp({
  label,
  lit,
  tone,
  testId,
}: {
  label: string;
  lit: boolean;
  tone: "green" | "red";
  testId: string;
}) {
  const on =
    tone === "green"
      ? "bg-green-500 shadow-[0_0_24px_#22c55e]"
      : "bg-red-500 shadow-[0_0_24px_#ef4444]";
  return (
    <div className="flex items-center gap-3" data-testid={testId} data-lit={lit}>
      <span
        aria-hidden
        className={`h-8 w-8 rounded-full border border-zinc-600 ${lit ? on : "bg-zinc-700"}`}
      />
      <span className="text-lg font-semibold tracking-widest">
        {label}
        <span className="sr-only">{lit ? " lamp lit" : " lamp off"}</span>
      </span>
    </div>
  );
}

export function Lamps({ ready, busy }: { ready: boolean; busy: boolean }) {
  return (
    <div className="flex gap-8" role="group" aria-label="Lamps">
      <Lamp label="READY" lit={ready && !busy} tone="green" testId="lamp-ready" />
      <Lamp label="BUSY" lit={busy} tone="red" testId="lamp-busy" />
    </div>
  );
}

/**
 * The Ballot button. It is disabled from the moment it is pressed until the server has answered
 * AND the new state has been fetched, so Ready is never shown while a session is still pending.
 * A ref (not state) guards the double press: two clicks in the same tick see the same render.
 */
export function BallotButton({
  allowed,
  reason,
  locked,
  send,
  onDone,
}: {
  allowed: boolean;
  reason: string | null;
  locked: boolean;
  send: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onDone: () => Promise<void>;
}) {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function press() {
    if (inFlight.current || !allowed || locked) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await send();
      if (!result.ok) setError(result.error);
      await onDone();
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  const note = locked
    ? "Screen locked: unlock to continue"
    : pending
      ? "Enabling the ballot…"
      : (error ?? (allowed ? null : reason));

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={press}
        disabled={!allowed || pending || locked}
        className="min-h-[120px] w-full rounded-xl bg-green-600 text-4xl font-bold tracking-[0.3em] text-white shadow-lg enabled:active:translate-y-0.5 disabled:cursor-not-allowed disabled:bg-zinc-600 disabled:text-zinc-400"
      >
        BALLOT
      </button>
      {note && (
        <p
          className={`text-sm ${error && !pending ? "text-red-300" : "text-zinc-300"}`}
          data-testid="ballot-reason"
          role={error && !pending ? "alert" : undefined}
        >
          {note}
        </p>
      )}
    </div>
  );
}
