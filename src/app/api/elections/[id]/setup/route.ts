import { getPool } from "@/lib/db/pool";

/**
 * Public: the frozen setup of an Election exactly as it was hashed, so anyone can recompute
 * the Setup Hash (SHA-256 of `canonical_json` as UTF-8). Nothing is returned for an Election
 * that has never been frozen. See docs/SETUP_FORMAT.md.
 */
export async function GET(
  _request: Request,
  { params }: RouteContext<"/api/elections/[id]/setup">,
) {
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const { rows } = await getPool().query<{
    freeze_no: number;
    setup_hash: string;
    canonical_json: string;
    status: string;
  }>(
    `select s.freeze_no, s.setup_hash, s.canonical_json, e.status
       from public.setup_snapshots s join public.elections e on e.id = s.election_id
      where s.election_id = $1 order by s.freeze_no desc limit 1`,
    [id],
  );
  const row = rows[0];
  if (!row || row.status !== "frozen")
    return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(
    {
      election_id: id,
      freeze_no: row.freeze_no,
      setup_hash: row.setup_hash,
      canonical_json: row.canonical_json,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
