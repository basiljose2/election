import { createSupabaseAdminClient } from "@/lib/auth/supabase";
import { MEDIA_BUCKET } from "@/lib/media/store";
import { mediaFileName } from "@/lib/media/images";

/**
 * Serves candidate images (public information) from the media bucket on our own origin, so
 * the Content Security Policy can stay `img-src 'self'`. Files are content-addressed, so they
 * can be cached forever.
 */
export async function GET(_request: Request, { params }: RouteContext<"/media/candidates/[hash]">) {
  const { hash } = await params;
  if (!/^[0-9a-f]{64}$/.test(hash)) return new Response("Not found", { status: 404 });

  const { data, error } = await createSupabaseAdminClient()
    .storage.from(MEDIA_BUCKET)
    .download(mediaFileName(hash));
  if (error || !data) return new Response("Not found", { status: 404 });

  return new Response(await data.arrayBuffer(), {
    headers: {
      "Content-Type": "image/webp",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
