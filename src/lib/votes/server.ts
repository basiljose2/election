import "server-only";
import { appendAuditEvent } from "@/lib/audit/append";
import { getPool } from "@/lib/db/pool";
import { serverEnv } from "@/lib/env/server";
import { getSignalPublisher } from "@/lib/signals/server";
import type { CastingDeps } from "./casting";
import { parseMasterKey } from "./keys";

/** Production dependencies for the casting routes. */
export async function castingDeps(): Promise<CastingDeps> {
  return {
    db: getPool(),
    now: () => new Date(),
    appendAudit: appendAuditEvent,
    publisher: await getSignalPublisher(),
    masterKey: parseMasterKey(serverEnv().voteSigningMasterKey),
  };
}
