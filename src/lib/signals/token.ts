import { createHmac, timingSafeEqual } from "node:crypto";
import type { TerminalType } from "@/lib/terminals/credentials";

export const CHANNEL_TOKEN_TTL_SECONDS = 15 * 60;

export interface ChannelClaims {
  aud: "authenticated";
  /** Postgres role used by Realtime authorization; the booth/type claims narrow it. */
  role: "authenticated";
  sub: string;
  booth_id: string;
  terminal_id: string;
  terminal_type: TerminalType;
  iat: number;
  exp: number;
}

const b64 = (value: object | Buffer) =>
  (Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))).toString("base64url");

/**
 * Mints a short-lived HS256 JWT scoped to ONE booth channel. Signed with the Supabase JWT
 * secret so Realtime accepts it; the Realtime authorization policy only lets such a token
 * receive `booth:<booth_id>`.
 */
export function mintChannelToken(
  secret: string,
  terminal: { id: string; boothId: string; type: TerminalType },
  now: Date,
): { token: string; expiresAt: Date } {
  const iat = Math.floor(now.getTime() / 1000);
  const claims: ChannelClaims = {
    aud: "authenticated",
    role: "authenticated",
    sub: terminal.id,
    booth_id: terminal.boothId,
    terminal_id: terminal.id,
    terminal_type: terminal.type,
    iat,
    exp: iat + CHANNEL_TOKEN_TTL_SECONDS,
  };
  const unsigned = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`;
  const signature = createHmac("sha256", secret).update(unsigned).digest();
  return {
    token: `${unsigned}.${b64(signature)}`,
    expiresAt: new Date(claims.exp * 1000),
  };
}

/** Verifies signature and expiry (used by tests and the Ably token bridge). */
export function verifyChannelToken(secret: string, token: string, now: Date): ChannelClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const expected = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
  const given = Buffer.from(parts[2]!, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as ChannelClaims;
  return claims.exp * 1000 > now.getTime() ? claims : null;
}
