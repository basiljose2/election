import { createHmac, randomBytes } from "node:crypto";
import { boothTopic, parseSignal, type Signal, type SignalPublisher } from "./types";

/**
 * Ably implementation of the SignalBus (the fallback provider, SIGNAL_PROVIDER=ably).
 * Server side only uses Ably's REST API, so no SDK is needed in serverless functions.
 *
 *  - publish: POST /channels/<channel>/messages with the API key (the only credential that can publish).
 *  - token request: a signed TokenRequest whose capability allows ONLY `subscribe` on this booth's channel
 *    for 15 minutes. Terminals therefore cannot publish and cannot read other booths.
 */

const ABLY_REST = "https://rest.ably.io";
export const ABLY_TOKEN_TTL_MS = 15 * 60 * 1000;

function splitKey(apiKey: string): { keyName: string; keySecret: string } {
  const [keyName, keySecret] = apiKey.split(":");
  if (!keyName || !keySecret)
    throw new Error("ABLY_API_KEY must look like <appId>.<keyId>:<secret>");
  return { keyName, keySecret };
}

export function ablyPublisher(config: {
  apiKey: string;
  restUrl?: string;
  fetchImpl?: typeof fetch;
}): SignalPublisher {
  const { keyName, keySecret } = splitKey(config.apiKey);
  const doFetch = config.fetchImpl ?? fetch;
  const basic = Buffer.from(`${keyName}:${keySecret}`).toString("base64");
  return {
    async publish(boothId: string, signal: Signal) {
      if (!parseSignal(signal)) throw new Error("invalid signal");
      const channel = encodeURIComponent(boothTopic(boothId));
      const response = await doFetch(
        `${config.restUrl ?? ABLY_REST}/channels/${channel}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Basic ${basic}` },
          body: JSON.stringify({ name: "signal", data: signal }),
        },
      );
      if (!response.ok) throw new Error(`Ably publish failed: ${response.status}`);
    },
  };
}

/** Builds a signed Ably TokenRequest for a single terminal (see Ably "Token Request" signing). */
export async function ablyTokenRequest(
  apiKey: string,
  terminal: { id: string; boothId: string },
  now: Date,
): Promise<{ tokenRequest: Record<string, unknown>; expiresAt: Date }> {
  const { keyName, keySecret } = splitKey(apiKey);
  const capability = JSON.stringify({ [boothTopic(terminal.boothId)]: ["subscribe"] });
  const ttl = String(ABLY_TOKEN_TTL_MS);
  const timestamp = String(now.getTime());
  const nonce = randomBytes(16).toString("hex");
  const clientId = terminal.id;
  const signText = [keyName, ttl, capability, clientId, timestamp, nonce]
    .map((p) => `${p}\n`)
    .join("");
  const mac = createHmac("sha256", keySecret).update(signText).digest("base64");
  return {
    tokenRequest: {
      keyName,
      ttl: Number(ttl),
      capability,
      clientId,
      timestamp: Number(timestamp),
      nonce,
      mac,
    },
    expiresAt: new Date(now.getTime() + ABLY_TOKEN_TTL_MS),
  };
}
