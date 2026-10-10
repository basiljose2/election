import { cookies } from "next/headers";
import { z } from "zod";
import { appendAuditEvent } from "@/lib/audit/append";
import { getPool } from "@/lib/db/pool";
import { getSignalPublisher } from "@/lib/signals/server";
import {
  newCredentialToken,
  PAIRING_NONCE_COOKIE,
  TERMINAL_COOKIES,
  terminalCookieOptions,
} from "@/lib/terminals/credentials";
import { collectPairing, submitPairingCode, type PairingDeps } from "@/lib/terminals/pairing";

const json = (status: number, body: object) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function deps(): Promise<PairingDeps> {
  return {
    db: getPool(),
    now: () => new Date(),
    appendAudit: appendAuditEvent,
    publisher: await getSignalPublisher(),
  };
}

/** The client address as seen by the platform (Vercel sets x-forwarded-for). */
function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "unknown";
}

const body = z.object({
  code: z.string().regex(/^\d{6}$/),
  // From the QR code: lets wrong guesses count against that booth's live code.
  booth: z.uuid().optional(),
});

/** A kiosk submits the one-time code shown on the Master Terminal. */
export async function POST(request: Request) {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json(400, { status: "invalid" });

  const jar = await cookies();
  let nonce = jar.get(PAIRING_NONCE_COOKIE.name)?.value;
  if (!nonce || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) nonce = newCredentialToken();

  const result = await submitPairingCode(await deps(), {
    code: parsed.data.code,
    ip: clientIp(request),
    nonce,
    boothHint: parsed.data.booth ?? null,
  });
  if (result.status === "pending") {
    jar.set(PAIRING_NONCE_COOKIE.name, nonce, {
      ...terminalCookieOptions(PAIRING_NONCE_COOKIE.path),
      maxAge: 10 * 60,
    });
    return json(200, result);
  }
  return json(result.status === "rate_limited" ? 429 : 400, { status: result.status });
}

/**
 * The kiosk asks how its request is going. When the Presiding Officer has confirmed, the
 * credential is set as an HttpOnly cookie (never in the response body).
 */
export async function GET() {
  const jar = await cookies();
  const nonce = jar.get(PAIRING_NONCE_COOKIE.name)?.value;
  if (!nonce) return json(200, { status: "unknown" });

  const result = await collectPairing(await deps(), { nonce });
  if (result.status === "paired") {
    jar.set(
      TERMINAL_COOKIES.voting.name,
      result.token,
      terminalCookieOptions(TERMINAL_COOKIES.voting.path),
    );
    jar.delete({ name: PAIRING_NONCE_COOKIE.name, path: PAIRING_NONCE_COOKIE.path });
    return json(200, { status: "paired" });
  }
  return json(200, result.status === "waiting" ? result : { status: result.status });
}
