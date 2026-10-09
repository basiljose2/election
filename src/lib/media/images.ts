import { createHash } from "node:crypto";
import sharp from "sharp";
import { CommandError } from "@/lib/commands/errors";

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/** Longest edge after re-encoding; candidate photos and symbols never need more. */
const MAX_EDGE_PX = 1024;
/** Guards against decompression bombs: a 2 MB file can declare enormous dimensions. */
const MAX_INPUT_PIXELS = 36_000_000;

export interface ProcessedImage {
  /** Re-encoded WebP bytes (metadata stripped). */
  bytes: Buffer;
  /** SHA-256 hex of `bytes`; the content-addressed file name is `${hash}.webp`. */
  hash: string;
}

/** The format implied by the file's leading bytes, regardless of its name or declared type. */
export function sniffImageType(head: Uint8Array): "png" | "jpeg" | "webp" | null {
  const is = (offset: number, ...bytes: number[]) => bytes.every((b, i) => head[offset + i] === b);
  if (is(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (is(0, 0xff, 0xd8, 0xff)) return "jpeg";
  if (is(0, 0x52, 0x49, 0x46, 0x46) && is(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  return null;
}

/**
 * Validates an uploaded image and re-encodes it. Rejects anything over 2 MB or whose
 * content is not a PNG, JPEG or WebP (the extension and declared type are never trusted).
 * Re-encoding drops metadata and any payload hidden in the original file.
 */
export async function processImage(input: Uint8Array): Promise<ProcessedImage> {
  if (input.byteLength === 0) {
    throw new CommandError("invalid_input", "The image file is empty");
  }
  if (input.byteLength > MAX_IMAGE_BYTES) {
    throw new CommandError("invalid_input", "Images must be 2 MB or smaller");
  }
  if (!sniffImageType(input)) {
    throw new CommandError("invalid_input", "Only PNG, JPEG or WebP images are accepted");
  }
  let bytes: Buffer;
  try {
    bytes = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
      .rotate()
      .resize({ width: MAX_EDGE_PX, height: MAX_EDGE_PX, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    throw new CommandError("invalid_input", "The image could not be read; it may be corrupt");
  }
  return { bytes, hash: createHash("sha256").update(bytes).digest("hex") };
}

export const mediaFileName = (hash: string): string => `${hash}.webp`;
