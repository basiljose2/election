/**
 * A small fixed-window rate limiter for the public endpoints (the app-level fallback behind
 * the Vercel Firewall rule). State is per server instance, which is the right granularity for
 * a fallback: it bounds what one client can do to one instance, with no shared store on the
 * public read path.
 */

export interface RateLimiterOptions {
  /** Requests allowed per window and key. */
  limit: number;
  windowMs: number;
  now?: () => number;
  /** Keys kept at most; the oldest windows are dropped first (memory bound). */
  maxKeys?: number;
}

export interface RateDecision {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets (for Retry-After). */
  retryAfterSeconds: number;
}

export function createRateLimiter(options: RateLimiterOptions) {
  const { limit, windowMs, maxKeys = 10_000 } = options;
  const now = options.now ?? Date.now;
  const windows = new Map<string, { start: number; count: number }>();

  return {
    check(key: string): RateDecision {
      const time = now();
      let entry = windows.get(key);
      if (!entry || time - entry.start >= windowMs) {
        entry = { start: time, count: 0 };
        windows.delete(key);
        windows.set(key, entry);
        if (windows.size > maxKeys) {
          const oldest = windows.keys().next().value;
          if (oldest !== undefined) windows.delete(oldest);
        }
      }
      entry.count += 1;
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.start + windowMs - time) / 1000));
      return {
        allowed: entry.count <= limit,
        remaining: Math.max(0, limit - entry.count),
        retryAfterSeconds,
      };
    },
  };
}

/** The client key for a request: the first address the proxy chain reports. */
export function clientKey(headers: { get(name: string): string | null }): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim() || "unknown";
  return headers.get("x-real-ip")?.trim() || "local";
}
