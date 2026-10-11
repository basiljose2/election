/**
 * Scrubbing for anything that leaves the application as monitoring data (an error tracker's
 * `beforeSend`, a log drain). The rule is allow-by-shape, not block-by-name alone: request
 * bodies, cookies and credentials never travel, any key that could carry a choice is dropped,
 * and identifiers inside free text are masked. An alert can say WHERE (route, booth, code),
 * never WHAT a voter chose.
 */

const DROPPED_KEYS = new Set(
  [
    // choices
    "candidate",
    "candidate_id",
    "candidate_ids",
    "candidateid",
    "candidateids",
    "choice",
    "choices",
    "selection",
    "selections",
    "vote_selection",
    "vote_selections",
    "answers",
    "answer",
    "nota",
    "ballot",
    "ballotdefinition",
    "ballot_definition",
    // credentials and secrets
    "cast_token",
    "casttoken",
    "idempotencykey",
    "idempotency_key",
    "password",
    "token",
    "secret",
    "authorization",
    "cookie",
    "set-cookie",
    "api_key",
    "apikey",
    "private_key",
    "signature",
  ].map((k) => k.toLowerCase()),
);

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_TOKEN = /\b[A-Za-z0-9_-]{40,}\b/g;
const MAX_STRING = 300;
const MAX_DEPTH = 8;

/** Masks identifiers and long tokens in free text, and bounds its length. */
export function scrubText(text: string): string {
  return text.replace(UUID, "<id>").replace(LONG_TOKEN, "<token>").slice(0, MAX_STRING);
}

export function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "<truncated>";
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrubValue(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (DROPPED_KEYS.has(key.toLowerCase())) continue;
      out[key] = scrubValue(inner, depth + 1);
    }
    return out;
  }
  return value;
}

/** The parts of an error-tracker event that matter here (Sentry-shaped). */
export interface MonitoringEvent {
  message?: string;
  request?: {
    url?: string;
    method?: string;
    data?: unknown;
    cookies?: unknown;
    headers?: Record<string, unknown>;
    query_string?: unknown;
  };
  exception?: { values?: Array<{ type?: string; value?: string; [key: string]: unknown }> };
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  breadcrumbs?: Array<{ message?: string; data?: unknown; [key: string]: unknown }>;
  user?: unknown;
  tags?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Use as `beforeSend`: returns a copy that carries no body, cookie, user or choice data. */
export function scrubEvent<T extends MonitoringEvent>(event: T): T {
  const copy: MonitoringEvent = { ...event };

  if (copy.request) {
    // Only the path (no query string, which could carry tokens) and the method are kept.
    let path = copy.request.url ?? "";
    try {
      path = new URL(path, "http://local").pathname;
    } catch {
      path = scrubText(path);
    }
    copy.request = { url: path, method: copy.request.method };
  }
  delete copy.user;
  if (copy.message) copy.message = scrubText(copy.message);
  if (copy.exception?.values) {
    copy.exception = {
      ...copy.exception,
      values: copy.exception.values.map((v) => ({
        ...v,
        value: v.value === undefined ? undefined : scrubText(v.value),
      })),
    };
  }
  if (copy.extra) copy.extra = scrubValue(copy.extra) as Record<string, unknown>;
  if (copy.contexts) copy.contexts = scrubValue(copy.contexts) as Record<string, unknown>;
  if (copy.tags) copy.tags = scrubValue(copy.tags) as Record<string, unknown>;
  if (copy.breadcrumbs) {
    copy.breadcrumbs = copy.breadcrumbs.map((b) => ({
      ...b,
      message: b.message === undefined ? undefined : scrubText(b.message),
      data: b.data === undefined ? undefined : scrubValue(b.data),
    }));
  }
  return copy as T;
}
