import { parseSignal, boothTopic, type Signal, type SignalPublisher } from "./types";

/**
 * Publishes to a Supabase Realtime private broadcast channel through the Realtime REST API,
 * using the server-only secret key. Terminals can only subscribe: the Realtime authorization
 * policies (supabase/migrations/..._realtime_authorization.sql) grant no INSERT to anyone.
 */
export function supabasePublisher(config: {
  supabaseUrl: string;
  secretKey: string;
  fetchImpl?: typeof fetch;
}): SignalPublisher {
  const doFetch = config.fetchImpl ?? fetch;
  return {
    async publish(boothId: string, signal: Signal) {
      if (!parseSignal(signal)) throw new Error("invalid signal");
      const response = await doFetch(
        `${config.supabaseUrl.replace(/\/$/, "")}/realtime/v1/api/broadcast`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: config.secretKey,
            Authorization: `Bearer ${config.secretKey}`,
          },
          body: JSON.stringify({
            messages: [
              { topic: boothTopic(boothId), event: "signal", payload: signal, private: true },
            ],
          }),
        },
      );
      if (!response.ok) throw new Error(`Realtime broadcast failed: ${response.status}`);
    },
  };
}
