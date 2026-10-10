import type { PoolClient } from "pg";
import {
  boothTopic,
  parseSignal,
  type Signal,
  type SignalPublisher,
  type SignalType,
} from "./types";

export { boothTopic };

/** What the publisher needs from a command/transaction context. */
export interface CommitScope {
  tx: Pick<PoolClient, "query">;
  onCommit(fn: () => Promise<void>): void;
}

/**
 * Increments the booth's state version inside the transaction and registers the signal to be
 * published only AFTER the transaction commits. If the transaction rolls back nothing is sent
 * (and the version bump rolls back with it). A failed publish is harmless: clients re-fetch
 * state on load, reconnect and by polling.
 */
export async function signalAfterCommit(
  scope: CommitScope,
  publisher: SignalPublisher,
  boothId: string,
  type: SignalType,
): Promise<number> {
  const { rows } = await scope.tx.query<{ version: string }>(
    "select public.bump_booth_state_version($1) as version",
    [boothId],
  );
  const signal: Signal = { type, version: Number(rows[0]!.version) };
  if (!parseSignal(signal)) throw new Error("invalid signal");
  scope.onCommit(() => publisher.publish(boothId, signal));
  return signal.version;
}
