import { getPool } from "@/lib/db/pool";
import { getPublicStatus } from "@/lib/transparency/public-data";

/**
 * Live booth states and turnout totals, cacheable at the CDN for 10 seconds so public traffic
 * never reaches the database more than once per ten seconds per region. Read only.
 */
export async function GET(
  _request: Request,
  { params }: RouteContext<"/public/api/elections/[id]/status">,
) {
  const { id } = await params;
  const status = await getPublicStatus(getPool(), id);
  if (!status) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(status, {
    headers: { "Cache-Control": "public, max-age=0, s-maxage=10, stale-while-revalidate=10" },
  });
}
