"use client";

import { useActionState } from "react";
import { Button, Notice } from "@/components/ui";
import { useTerminalState } from "@/lib/signals/use-terminal-state";
import {
  confirmPairingAction,
  generateCodeAction,
  rejectPairingAction,
  type CodeResult,
} from "./actions";

interface MasterState {
  role: "master";
  version: number;
  boothState: string;
  ballotPending: boolean;
  ballotsCast: number;
  votingTerminal: {
    paired: boolean;
    deviceId: string | null;
    online: boolean;
    lastSeenAt: string | null;
  };
  pairing: {
    codeId: string;
    status: "active" | "pending" | "confirmed";
    expiresAt: string;
    deviceId: string | null;
  } | null;
}

export function MasterPanel({ boothId }: { boothId: string }) {
  const { state, mode, unpaired } = useTerminalState<MasterState>({ base: "/master/api" });
  const [generated, generate, generating] = useActionState<CodeResult, FormData>(
    generateCodeAction,
    null,
  );

  if (unpaired) {
    return (
      <Notice tone="error">
        This device is no longer the Master Terminal. Reload the page to register it again.
      </Notice>
    );
  }
  if (!state) return <p>Loading…</p>;

  const vt = state.votingTerminal;
  const pending = state.pairing?.status === "pending" ? state.pairing : null;
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-1" aria-label="Status">
        <p className="text-sm text-zinc-600 dark:text-zinc-400" data-testid="master-connection">
          Connection: {mode === "realtime" ? "live" : mode === "polling" ? "polling" : "connecting"}{" "}
          · Booth state: {state.boothState} · Ballots cast: {state.ballotsCast}
        </p>
        <p data-testid="voting-terminal-status">
          Voting Terminal:{" "}
          {!vt.paired ? (
            <strong>not paired</strong>
          ) : (
            <>
              <strong data-testid="voting-terminal-online">
                {vt.online ? "online" : "offline"}
              </strong>
              {vt.deviceId && ` (device ${vt.deviceId})`}
              {vt.lastSeenAt && ` · last heartbeat ${new Date(vt.lastSeenAt).toLocaleTimeString()}`}
            </>
          )}
        </p>
      </section>

      <section className="flex flex-col gap-3" aria-label="Pair a Voting Terminal">
        <h2 className="text-lg font-medium">
          {vt.paired ? "Replace the Voting Terminal" : "Pair a Voting Terminal"}
        </h2>
        {pending?.deviceId ? (
          <div
            className="flex flex-col gap-3 rounded-md border border-zinc-300 p-4 dark:border-zinc-700"
            data-testid="pending-device"
          >
            <p>A device is asking to pair. Confirm that the kiosk shows this id:</p>
            <p className="font-mono text-4xl tracking-widest" data-testid="pending-device-id">
              {pending.deviceId}
            </p>
            <div className="flex gap-3">
              <form action={confirmPairingAction}>
                <input type="hidden" name="boothId" value={boothId} />
                <input type="hidden" name="codeId" value={pending.codeId} />
                <input type="hidden" name="deviceId" value={pending.deviceId} />
                <Button type="submit">Confirm</Button>
              </form>
              <form action={rejectPairingAction}>
                <input type="hidden" name="boothId" value={boothId} />
                <input type="hidden" name="codeId" value={pending.codeId} />
                <input type="hidden" name="deviceId" value={pending.deviceId} />
                <Button type="submit" variant="danger">
                  Reject
                </Button>
              </form>
            </div>
          </div>
        ) : (
          <form action={generate} className="flex flex-col gap-3">
            <input type="hidden" name="boothId" value={boothId} />
            <div>
              <Button type="submit" disabled={generating}>
                Generate pairing code
              </Button>
            </div>
          </form>
        )}
        {generated && !generated.ok && <Notice tone="error">{generated.error}</Notice>}
        {generated?.ok && state.pairing?.status === "active" && (
          <div className="flex flex-wrap items-center gap-6" data-testid="pairing-code-panel">
            <p className="font-mono text-5xl tracking-widest" data-testid="pairing-code">
              {generated.code}
            </p>
            <div
              role="img"
              aria-label="QR code with the pairing link"
              className="h-48 w-48 bg-white p-1"
              dangerouslySetInnerHTML={{ __html: generated.qrSvg }}
            />
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Valid until {new Date(state.pairing.expiresAt).toLocaleTimeString()}. Single use.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
