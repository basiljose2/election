import {
  parseSignal,
  type ConnectionStatus,
  type Signal,
  type SignalBus,
  type Subscription,
} from "./types";

/**
 * In-memory SignalBus for tests. `authorize` stands in for the provider's channel
 * authorization (only a valid token for the booth may subscribe); `setConnected(false)`
 * simulates an outage.
 */
export class MemorySignalBus implements SignalBus {
  private readonly listeners = new Map<
    string,
    Set<{ onSignal(s: Signal): void; onStatus(s: ConnectionStatus): void }>
  >();
  private connected = true;
  readonly published: Array<{ boothId: string; signal: Signal }> = [];

  constructor(
    private readonly authorize: (boothId: string, token: string) => boolean = () => true,
  ) {}

  async publish(boothId: string, signal: Signal): Promise<void> {
    if (!parseSignal(signal)) throw new Error("invalid signal");
    this.published.push({ boothId, signal });
    if (!this.connected) return;
    for (const l of this.listeners.get(boothId) ?? []) l.onSignal({ ...signal });
  }

  subscribe(
    channel: { boothId: string; token: string },
    handlers: { onSignal(s: Signal): void; onStatus(s: ConnectionStatus): void },
  ): Subscription {
    if (!this.authorize(channel.boothId, channel.token)) {
      queueMicrotask(() => handlers.onStatus("disconnected"));
      return { unsubscribe() {} };
    }
    const set = this.listeners.get(channel.boothId) ?? new Set();
    this.listeners.set(channel.boothId, set);
    set.add(handlers);
    queueMicrotask(() => handlers.onStatus(this.connected ? "connected" : "disconnected"));
    return { unsubscribe: () => void set.delete(handlers) };
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    for (const set of this.listeners.values()) {
      for (const l of set) l.onStatus(connected ? "connected" : "disconnected");
    }
  }
}
