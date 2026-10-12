import { getPool } from "@/lib/db/pool";
import { serverEnv } from "@/lib/env/server";
import { parseMasterKey } from "@/lib/votes/keys";

/**
 * Uptime check: the application is up, can reach its database, and has what casting needs.
 * It reveals nothing else (no versions, no names of what is missing) and is never cached.
 * A deployment that cannot sign votes reports `misconfigured`, so the uptime alert fires
 * before polling day instead of at the first ballot.
 */
export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  try {
    await getPool().query("select 1");
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503, headers });
  }
  try {
    parseMasterKey(serverEnv().voteSigningMasterKey);
    return Response.json({ status: "ok" }, { headers });
  } catch {
    return Response.json({ status: "misconfigured" }, { status: 503, headers });
  }
}
