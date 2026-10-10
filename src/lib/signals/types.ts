/**
 * Signals are hints that something changed at a booth. They carry a type and the booth's
 * state version, nothing else: never a candidate, a NOTA choice or any ballot content.
 * Clients always re-fetch authoritative state from the server when one arrives.
 */
export const SIGNAL_TYPES = [
  "ballot-enabled",
  "ballot-cancelled",
  "ballot-cast",
  "booth-state-changed",
  "terminal-revoked",
  "pairing-changed",
] as const;

export type SignalType = (typeof SIGNAL_TYPES)[number];

export interface Signal {
  type: SignalType;
  /** The booth's state version when the signal was published. */
  version: number;
}

export const boothTopic = (boothId: string): string => `booth:${boothId}`;

/** Strict check used on both ends: exactly {type, version}, nothing more. */
export function parseSignal(value: unknown): Signal | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("type") || !keys.includes("version")) return null;
  const { type, version } = value as { type: unknown; version: unknown };
  if (typeof type !== "string" || !(SIGNAL_TYPES as readonly string[]).includes(type)) return null;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) return null;
  return { type: type as SignalType, version };
}

/** Server side: only the server publishes. */
export interface SignalPublisher {
  publish(boothId: string, signal: Signal): Promise<void>;
}

export type ConnectionStatus = "connected" | "disconnected";

export interface Subscription {
  unsubscribe(): void;
}

/** Client side: subscribe with a server-minted, booth-scoped channel token. */
export interface SignalSubscriber {
  subscribe(
    channel: { boothId: string; token: string },
    handlers: {
      onSignal(signal: Signal): void;
      onStatus(status: ConnectionStatus): void;
    },
  ): Subscription;
}

/** Both halves, as implemented by each provider. */
export interface SignalBus extends SignalPublisher, SignalSubscriber {}
