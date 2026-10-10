import {
  boothTopic,
  parseSignal,
  type ConnectionStatus,
  type SignalSubscriber,
  type Subscription,
} from "./types";

/**
 * Browser side of the Ably SignalBus. The Ably SDK is loaded only when this provider is
 * selected, so the default (Supabase) bundle stays small. `channel.token` is a JSON-encoded
 * Ably TokenRequest minted by the server.
 */
export function ablySubscriber(): SignalSubscriber {
  return {
    subscribe(channel, handlers): Subscription {
      let closed = false;
      let teardown: (() => void) | undefined;
      const report = (status: ConnectionStatus) => {
        if (!closed) handlers.onStatus(status);
      };

      void (async () => {
        const Ably = await import("ably");
        if (closed) return;
        const tokenRequest = JSON.parse(channel.token) as Record<string, unknown>;
        const client = new Ably.Realtime({
          authCallback: (_params, callback) => callback(null, tokenRequest as never),
          autoConnect: true,
        });
        const topic = client.channels.get(boothTopic(channel.boothId));
        // "Connected" means this booth's channel is attached: a token that does not allow the
        // channel leaves the connection up but the channel failed, which must read as disconnected.
        topic.on((change) => {
          report(change.current === "attached" ? "connected" : "disconnected");
        });
        client.connection.on((change) => {
          if (change.current !== "connected") report("disconnected");
        });
        await topic.subscribe("signal", (message) => {
          const signal = parseSignal(message.data);
          if (signal && !closed) handlers.onSignal(signal);
        });
        teardown = () => client.close();
        if (closed) teardown();
      })().catch(() => report("disconnected"));

      return {
        unsubscribe() {
          closed = true;
          teardown?.();
        },
      };
    },
  };
}
