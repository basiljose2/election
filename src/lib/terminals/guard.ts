import type { Pool } from "pg";
import type { AppendAuditEvent } from "@/lib/audit/append";
import { withTransaction } from "@/lib/db/pool";
import { DEVICE_ACTOR } from "./pairing";
import {
  verifyTerminalCredential,
  type AuthenticatedTerminal,
  type TerminalType,
} from "./credentials";

export type GuardResult =
  | { ok: true; terminal: AuthenticatedTerminal }
  | { ok: false; status: 401 | 403; error: "unauthenticated" | "forbidden" };

/**
 * Terminal-type authorization for every terminal endpoint: the credential must be active, of
 * the type the route is for, bound to the booth the request names (if any), and the booth must
 * still accept terminals. A credential of the wrong type or booth is a security event and is
 * audited; unknown, revoked or missing credentials are simply unauthenticated.
 */
export async function guardTerminal(
  deps: { db: Pool; appendAudit: AppendAuditEvent },
  presented: string | undefined | null,
  expect: { type: TerminalType; boothId?: string },
  route: string,
): Promise<GuardResult> {
  const check = await verifyTerminalCredential(deps.db, presented, expect);
  if (check.ok) return { ok: true, terminal: check.terminal };

  if ((check.reason === "wrong_type" || check.reason === "wrong_booth") && check.known) {
    const known = check.known;
    await withTransaction(deps.db, (tx) =>
      deps.appendAudit(tx, {
        electionId: known.electionId,
        eventType: "terminal.rejected",
        actor: DEVICE_ACTOR(known.terminalId),
        target: { type: "route", id: route },
        detail: {
          reason: check.reason,
          credential_type: known.type,
          required_type: expect.type,
          credential_booth_id: known.boothId,
          requested_booth_id: expect.boothId ?? null,
        },
      }),
    ).catch((e) => console.error("[guard] failed to audit rejection", e));
    return { ok: false, status: 403, error: "forbidden" };
  }
  return { ok: false, status: 401, error: "unauthenticated" };
}
