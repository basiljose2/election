import { requireActorForCommand } from "@/lib/auth/current-actor";
import { isCommandError } from "@/lib/commands/errors";
import { getPool } from "@/lib/db/pool";
import { getAuditFeed } from "@/lib/transparency/audit-feed";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Audit Events after `?after=<seq>` for the Election's Observers (and officers). */
export async function GET(request: Request, { params }: RouteContext<"/api/elections/[id]/audit">) {
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ error: "not_found" }, { status: 404 });
  const after = Math.max(0, Number(new URL(request.url).searchParams.get("after") ?? 0) || 0);
  try {
    const actor = await requireActorForCommand();
    const feed = await getAuditFeed(getPool(), actor, id, after);
    return Response.json(feed, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isCommandError(error)) {
      return Response.json(
        { error: error.code },
        {
          status: error.code === "forbidden" ? 403 : 401,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
    throw error;
  }
}
