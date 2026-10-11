import { requireActorForCommand } from "@/lib/auth/current-actor";
import { isCommandError } from "@/lib/commands/errors";
import { getPool } from "@/lib/db/pool";
import { getPollingDashboard } from "@/lib/results/polling-dashboard";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Live booth status for the Returning Officer's dashboard (and Observers): totals and states
 * only. It polls this every few seconds; per-candidate counts are not part of the response.
 */
export async function GET(
  _request: Request,
  { params }: RouteContext<"/api/elections/[id]/dashboard">,
) {
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ error: "not_found" }, { status: 404 });
  try {
    const actor = await requireActorForCommand();
    const dashboard = await getPollingDashboard(getPool(), actor, id);
    return Response.json(dashboard, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isCommandError(error)) {
      const status = error.code === "forbidden" ? 403 : error.code === "not_found" ? 404 : 401;
      return Response.json(
        { error: error.code },
        { status, headers: { "Cache-Control": "no-store" } },
      );
    }
    throw error;
  }
}
