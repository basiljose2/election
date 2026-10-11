import { requireActorForCommand } from "@/lib/auth/current-actor";
import { electionGrant } from "@/lib/auth/roles";
import { isCommandError } from "@/lib/commands/errors";
import { getPool } from "@/lib/db/pool";
import { loadResult } from "@/lib/results/declare";
import { resultCsv, resultJson, resultPdf } from "@/lib/results/exports";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const headers = (type: string, name: string) => ({
  "Content-Type": type,
  "Content-Disposition": `attachment; filename="${name}"`,
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
});

/** Exports of the declared Result (PDF, CSV, signed JSON) for the election's Returning Officer. */
export async function GET(
  _request: Request,
  { params }: RouteContext<"/api/elections/[id]/results/[format]">,
) {
  const { id, format } = await params;
  if (!UUID.test(id) || !["pdf", "csv", "json"].includes(format)) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  try {
    const actor = await requireActorForCommand();
    if (!electionGrant(actor, id, ["returning_officer"])) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const result = await loadResult(getPool(), id);
    if (!result) return Response.json({ error: "not_found" }, { status: 404 });

    const short = result.resultHash.slice(0, 12);
    if (format === "csv") {
      return new Response(resultCsv(result), {
        headers: headers("text/csv; charset=utf-8", `results-${short}.csv`),
      });
    }
    if (format === "pdf") {
      return new Response(new Uint8Array(resultPdf(result)), {
        headers: headers("application/pdf", `results-${short}.pdf`),
      });
    }
    const key = await getPool().query<{ public_key: string }>(
      "select public_key from public.election_signing_keys where election_id = $1",
      [id],
    );
    return new Response(resultJson(result, key.rows[0]?.public_key ?? ""), {
      headers: headers("application/json; charset=utf-8", `results-${short}.json`),
    });
  } catch (error) {
    if (isCommandError(error)) {
      return Response.json(
        { error: error.code },
        { status: error.code === "forbidden" ? 403 : 401 },
      );
    }
    throw error;
  }
}
