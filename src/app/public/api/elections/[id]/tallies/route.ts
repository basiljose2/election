import { getPool } from "@/lib/db/pool";
import { getPublicSetup, getPublicTallies } from "@/lib/transparency/public-data";

/** Booth Tallies as they close: hashes, Merkle roots and signatures, never candidate counts. */
export async function GET(
  _request: Request,
  { params }: RouteContext<"/public/api/elections/[id]/tallies">,
) {
  const { id } = await params;
  if (!(await getPublicSetup(getPool(), id))) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  return Response.json(
    { election_id: id, tallies: await getPublicTallies(getPool(), id) },
    { headers: { "Cache-Control": "public, max-age=0, s-maxage=30, stale-while-revalidate=30" } },
  );
}
