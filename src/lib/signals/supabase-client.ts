import { RealtimeClient } from "@supabase/realtime-js";
import {
  boothTopic,
  parseSignal,
  type ConnectionStatus,
  type Signal,
  type SignalSubscriber,
  type Subscription,
} from "./types";

/**
 * Browser side of the Supabase Realtime SignalBus. Uses the lightweight realtime client (not
 * the whole Supabase SDK) to keep the voting-terminal bundle small. The server supplies the
 * Realtime URL, the publishable API key and a short-lived, booth-scoped token.
 */
export function supabaseSubscriber(config: {
  realtimeUrl: string;
  apiKey: string;
}): SignalSubscriber {
  return {
    subscribe(channel, handlers): Subscription {
      const client = new RealtimeClient(config.realtimeUrl, {
        params: { apikey: config.apiKey },
        // The token is the credential; reconnects reuse it until the page refreshes it.
        accessToken: async () => channel.token,
      });
      const topic = client.channel(boothTopic(channel.boothId), { config: { private: true } });
      let closed = false;
      const report = (status: ConnectionStatus) => {
        if (!closed) handlers.onStatus(status);
      };

      topic
        .on("broadcast", { event: "signal" }, (message: { payload?: unknown }) => {
          // Anything that is not exactly {type, version} is ignored.
          const signal: Signal | null = parseSignal(message.payload);
          if (signal && !closed) handlers.onSignal(signal);
        })
        .subscribe((status: string) => {
          report(status === "SUBSCRIBED" ? "connected" : "disconnected");
        });

      return {
        unsubscribe() {
          closed = true;
          void client.removeChannel(topic);
          client.disconnect();
        },
      };
    },
  };
}
