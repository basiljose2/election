import type { Answer } from "@/lib/votes/validate";

export type CastOutcome =
  /** Recorded (including "already recorded with this key"). */
  | { kind: "recorded" }
  /** The Presiding Officer cancelled the session. */
  | { kind: "cancelled" }
  /** A definitive refusal; retrying cannot help. */
  | { kind: "refused" }
  | { kind: "aborted" };

export interface CastRequest {
  castToken: string;
  idempotencyKey: string;
  answers: Answer[];
}

export interface CastDeps {
  fetch: typeof fetch;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  signal: AbortSignal;
}

export const BACKOFF_START_MS = 500;
export const BACKOFF_MAX_MS = 4_000;

export const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Sends the ballot and keeps sending it, with the SAME idempotency key, until the server gives
 * a definitive answer: network errors and server errors are retried without limit, with
 * exponential backoff from 0.5 s to 4 s.
 */
export async function castWithRetry(request: CastRequest, deps: CastDeps): Promise<CastOutcome> {
  let delay = BACKOFF_START_MS;
  while (!deps.signal.aborted) {
    try {
      const response = await deps.fetch("/terminal/api/cast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        cache: "no-store",
        signal: deps.signal,
      });
      if (response.status === 200) return { kind: "recorded" };
      if (response.status < 500 && response.status !== 408 && response.status !== 429) {
        if (response.status === 409) {
          const body = (await response.json().catch(() => null)) as { reason?: string } | null;
          if (body?.reason === "cancelled") return { kind: "cancelled" };
        }
        return { kind: "refused" };
      }
    } catch {
      if (deps.signal.aborted) break;
    }
    await deps.sleep(delay, deps.signal);
    delay = Math.min(delay * 2, BACKOFF_MAX_MS);
  }
  return { kind: "aborted" };
}
