import { getPool } from "@/lib/db/pool";

/**
 * Uptime check: the application is up and can reach its database. It reveals nothing else
 * (no versions, no configuration) and is never cached.
 */
export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  try {
    await getPool().query("select 1");
    return Response.json({ status: "ok" }, { headers });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503, headers });
  }
}
