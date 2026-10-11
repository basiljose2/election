import { getPool } from "@/lib/db/pool";
import { getPublicResult, getPublicSetup } from "@/lib/transparency/public-data";

/**
 * The signed Result. Before declaration there is no Result and nothing about candidates is
 * returned. After declaration it can never change, so it is cached for a long time.
 */
export async function GET(
  _request: Request,
  { params }: RouteContext<"/public/api/elections/[id]/result">,
) {
  const { id } = await params;
  if (!(await getPublicSetup(getPool(), id))) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const result = await getPublicResult(getPool(), id);
  if (!result) {
    return Response.json(
      { election_id: id, declared: false },
      { headers: { "Cache-Control": "public, max-age=0, s-maxage=10" } },
    );
  }
  return Response.json(
    {
      election_id: id,
      declared: true,
      result_hash: result.resultHash,
      signature: result.signature,
      canonical_json: result.canonicalJson,
    },
    { headers: { "Cache-Control": "public, max-age=31536000, immutable" } },
  );
}
