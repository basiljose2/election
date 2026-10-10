import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool | PoolClient, "query">;

export type TerminalType = "master" | "voting";

/** Device cookies. The path keeps a Voting Terminal's credential off master routes (and vice versa). */
export const TERMINAL_COOKIES = {
  master: { name: "evm_master", path: "/master" },
  voting: { name: "evm_terminal", path: "/terminal" },
} as const satisfies Record<TerminalType, { name: string; path: string }>;

/** Holds the unconfirmed device's nonce while it waits for the Presiding Officer. */
export const PAIRING_NONCE_COOKIE = { name: "evm_pairing", path: "/terminal" } as const;

export const terminalCookieOptions = (path: string) =>
  ({ httpOnly: true, secure: true, sameSite: "strict", path }) as const;

/** 256 random bits, URL-safe. Only its hash is ever stored on the server. */
export function newCredentialToken(): string {
  return randomBytes(32).toString("base64url");
}

export const hashCredential = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

/** A well-formed token is exactly 43 base64url characters (256 bits). */
export const isWellFormedToken = (token: unknown): token is string =>
  typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);

export function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface AuthenticatedTerminal {
  id: string;
  electionId: string;
  boothId: string;
  type: TerminalType;
  deviceId: string | null;
}

export type CredentialFailure =
  "missing" | "malformed" | "unknown" | "revoked" | "wrong_type" | "wrong_booth" | "booth_closed";

export type CredentialCheck =
  | { ok: true; terminal: AuthenticatedTerminal }
  | {
      ok: false;
      reason: CredentialFailure;
      /** The terminal the credential belongs to, when it is a known credential. */
      known?: { terminalId: string; electionId: string; boothId: string; type: TerminalType };
    };

/**
 * Checks a presented credential against the database: it must belong to an active terminal of
 * the required type, bound to the expected booth (when the caller names one), at a booth that
 * still accepts terminals (a Closed or Sealed booth rejects every terminal credential).
 */
export async function verifyTerminalCredential(
  db: Queryable,
  presented: string | undefined | null,
  expect: { type: TerminalType; boothId?: string },
): Promise<CredentialCheck> {
  if (!presented) return { ok: false, reason: "missing" };
  if (!isWellFormedToken(presented)) return { ok: false, reason: "malformed" };

  const { rows } = await db.query<{
    id: string;
    election_id: string;
    booth_id: string;
    type: TerminalType;
    status: "active" | "revoked";
    device_id: string | null;
    accepts: boolean;
  }>(
    `select t.id, t.election_id, t.booth_id, t.type, t.status, t.device_id,
            public.booth_accepts_terminals(t.booth_id) as accepts
       from public.terminals t where t.credential_hash = $1`,
    [hashCredential(presented)],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: "unknown" };
  const known = {
    terminalId: row.id,
    electionId: row.election_id,
    boothId: row.booth_id,
    type: row.type,
  };
  if (row.status !== "active") return { ok: false, reason: "revoked", known };
  if (row.type !== expect.type) return { ok: false, reason: "wrong_type", known };
  if (expect.boothId && row.booth_id !== expect.boothId) {
    return { ok: false, reason: "wrong_booth", known };
  }
  if (!row.accepts) return { ok: false, reason: "booth_closed", known };
  return {
    ok: true,
    terminal: {
      id: row.id,
      electionId: row.election_id,
      boothId: row.booth_id,
      type: row.type,
      deviceId: row.device_id,
    },
  };
}

/** Inserts a terminal for a freshly generated credential and returns the raw token (once). */
export async function issueTerminal(
  tx: Queryable,
  input: {
    electionId: string;
    boothId: string;
    type: TerminalType;
    deviceId?: string | null;
    registeredBy?: string | null;
  },
): Promise<{ terminalId: string; token: string }> {
  const token = newCredentialToken();
  const { rows } = await tx.query<{ id: string }>(
    `insert into public.terminals (election_id, booth_id, type, credential_hash, device_id, registered_by)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      input.electionId,
      input.boothId,
      input.type,
      hashCredential(token),
      input.deviceId ?? null,
      input.registeredBy ?? null,
    ],
  );
  return { terminalId: rows[0]!.id, token };
}

/** Revokes the active terminal of this type at the booth, if any. Returns its id. */
export async function revokeActiveTerminal(
  tx: Queryable,
  boothId: string,
  type: TerminalType,
  reason: string,
): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(
    `update public.terminals set status = 'revoked', revoked_at = now(), revoked_reason = $3
      where booth_id = $1 and type = $2 and status = 'active' returning id`,
    [boothId, type, reason],
  );
  return rows[0]?.id ?? null;
}
