import "server-only";
import { createSupabaseAdminClient } from "@/lib/auth/supabase";
import { mediaFileName } from "./images";

/**
 * Where re-encoded candidate images live. Files are content-addressed, so writes are
 * idempotent and a file orphaned by a rolled-back command is harmless (and never deleted,
 * because another Candidate may reference the same hash).
 */
export interface ImageStore {
  put(hash: string, bytes: Buffer): Promise<void>;
}

export const MEDIA_BUCKET = "candidate-media";

/**
 * Supabase Storage (public bucket: candidate images are public information). Only server
 * commands hold the secret key and can write. Browsers read images through our own
 * `/media/candidates/<hash>` route so the Content Security Policy stays `img-src 'self'`.
 */
export function supabaseImageStore(): ImageStore {
  const client = createSupabaseAdminClient();
  const bucket = client.storage.from(MEDIA_BUCKET);
  let ensured = false;

  return {
    async put(hash, bytes) {
      if (!ensured) {
        const { error } = await client.storage.createBucket(MEDIA_BUCKET, { public: true });
        if (error && !/already exists|duplicate/i.test(error.message)) throw error;
        ensured = true;
      }
      const { error } = await bucket.upload(mediaFileName(hash), bytes, {
        contentType: "image/webp",
        upsert: true,
        cacheControl: "31536000",
      });
      if (error) throw error;
    },
  };
}

/** Same-origin URL used in pages. */
export const candidateImageUrl = (hash: string): string => `/media/candidates/${hash}`;

/**
 * Removes every uploaded candidate image (test-data erase only). Best effort: returns how many
 * files were removed; a missing bucket is not an error.
 */
export async function clearMediaBucket(): Promise<number> {
  const bucket = createSupabaseAdminClient().storage.from(MEDIA_BUCKET);
  let removed = 0;
  for (let round = 0; round < 50; round++) {
    const { data, error } = await bucket.list("", { limit: 1000 });
    if (error || !data || data.length === 0) break;
    const names = data.filter((f) => f.name).map((f) => f.name);
    const { error: removeError } = await bucket.remove(names);
    if (removeError) break;
    removed += names.length;
  }
  return removed;
}
