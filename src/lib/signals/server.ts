import "server-only";
import { serverEnv } from "@/lib/env/server";
import type { AuthenticatedTerminal } from "@/lib/terminals/credentials";
import { supabasePublisher } from "./supabase";
import { mintChannelToken } from "./token";
import { boothTopic, type SignalPublisher } from "./types";

/** What a terminal needs to subscribe, minted by the server for ONE booth. */
export type ChannelAccess =
  | {
      provider: "supabase";
      topic: string;
      token: string;
      expiresAt: string;
      realtimeUrl: string;
      apiKey: string;
    }
  | {
      provider: "ably";
      topic: string;
      /** An Ably TokenRequest restricted to subscribing to this booth's channel. */
      tokenRequest: Record<string, unknown>;
      expiresAt: string;
    };

let publisher: SignalPublisher | undefined;

/** The server's publisher for the configured provider (SIGNAL_PROVIDER). */
export async function getSignalPublisher(): Promise<SignalPublisher> {
  if (publisher) return publisher;
  const env = serverEnv();
  if (env.signalProvider === "ably") {
    const { ablyPublisher } = await import("./ably");
    if (!env.ablyApiKey) throw new Error("ABLY_API_KEY is required when SIGNAL_PROVIDER=ably");
    publisher = ablyPublisher({ apiKey: env.ablyApiKey });
  } else {
    publisher = supabasePublisher({
      supabaseUrl: env.supabaseUrl,
      secretKey: env.supabaseSecretKey,
    });
  }
  return publisher;
}

/** Mints a short-lived, booth-scoped credential for the terminal that asked. */
export async function mintChannelAccess(
  terminal: AuthenticatedTerminal,
  now: Date,
): Promise<ChannelAccess> {
  const env = serverEnv();
  const topic = boothTopic(terminal.boothId);
  if (env.signalProvider === "ably") {
    const { ablyTokenRequest } = await import("./ably");
    if (!env.ablyApiKey) throw new Error("ABLY_API_KEY is required when SIGNAL_PROVIDER=ably");
    const { tokenRequest, expiresAt } = await ablyTokenRequest(env.ablyApiKey, terminal, now);
    return { provider: "ably", topic, tokenRequest, expiresAt: expiresAt.toISOString() };
  }
  if (!env.supabaseJwtSecret)
    throw new Error("SUPABASE_JWT_SECRET is required for terminal channels");
  const { token, expiresAt } = mintChannelToken(
    env.supabaseJwtSecret,
    { id: terminal.id, boothId: terminal.boothId, type: terminal.type },
    now,
  );
  return {
    provider: "supabase",
    topic,
    token,
    expiresAt: expiresAt.toISOString(),
    realtimeUrl: `${env.supabaseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/realtime/v1`,
    apiKey: env.supabasePublishableKey,
  };
}
