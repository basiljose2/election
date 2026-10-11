import { getPool } from "@/lib/db/pool";
import { ensureBundle } from "@/lib/transparency/bundle";
import { getPublicResult, getPublicSetup } from "@/lib/transparency/public-data";

/**
 * The verification bundle of a declared Election, served from the stored copy (and created on
 * first use if the post-declaration step did not run). It never changes, so it is cached hard
 * and keyed by its hash.
 */
export async function GET(
  _request: Request,
  { params }: RouteContext<"/public/elections/[id]/bundle">,
) {
  const { id } = await params;
  if (!(await getPublicSetup(getPool(), id)) || !(await getPublicResult(getPool(), id))) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const bundle = await ensureBundle(getPool(), id);
  if (!bundle) return Response.json({ error: "not_found" }, { status: 404 });
  return new Response(new Uint8Array(bundle.zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="verification-bundle-${bundle.bundleHash.slice(0, 12)}.zip"`,
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: `"${bundle.bundleHash}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
