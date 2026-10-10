/**
 * The application logger for code that may handle vote choices.
 *
 * Only an allowlist of fields is ever written, and only primitive values: a request body, an
 * answer, a candidate id or an error object with its message cannot reach a log line by
 * accident. Everything else is dropped (and counted). Casting modules are forbidden from
 * using `console.*` directly (see eslint.config.mjs); this file is the one place that does.
 */

export type LogLevel = "info" | "warn" | "error";

/** Fields that identify WHERE something happened, never WHAT a voter chose. */
const ALLOWED_FIELDS = new Set([
  "election_id",
  "booth_id",
  "session_id",
  "terminal_id",
  "route",
  "error_code",
  "status",
  "issue_codes",
  "duration_ms",
  "attempt",
]);

type LogValue = string | number | boolean | null;
export type LogFields = Record<string, unknown>;

export interface LogRecord {
  level: LogLevel;
  event: string;
  fields: Record<string, LogValue | LogValue[]>;
  dropped_fields: number;
}

export type LogSink = (record: LogRecord) => void;

const consoleSink: LogSink = (record) => {
  console[record.level === "info" ? "log" : record.level](JSON.stringify(record));
};

let sink: LogSink = consoleSink;

/** Tests replace the sink to inspect exactly what would be logged. */
export function setLogSink(next: LogSink | null): void {
  sink = next ?? consoleSink;
}

const isPrimitive = (value: unknown): value is LogValue =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

/** Short, id-shaped or code-shaped strings only; long free text is never allowed through. */
const safeString = (value: string) => /^[A-Za-z0-9_.:/-]{0,80}$/.test(value);

export function redact(fields: LogFields): {
  fields: Record<string, LogValue | LogValue[]>;
  dropped: number;
} {
  const kept: Record<string, LogValue | LogValue[]> = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.has(key)) {
      dropped++;
    } else if (Array.isArray(value) && value.every((v) => typeof v === "string" && safeString(v))) {
      kept[key] = value as string[];
    } else if (isPrimitive(value) && (typeof value !== "string" || safeString(value))) {
      kept[key] = value;
    } else {
      dropped++;
    }
  }
  return { fields: kept, dropped };
}

function write(level: LogLevel, event: string, fields: LogFields = {}) {
  const { fields: kept, dropped } = redact(fields);
  sink({ level, event, fields: kept, dropped_fields: dropped });
}

export const logger = {
  info: (event: string, fields?: LogFields) => write("info", event, fields),
  warn: (event: string, fields?: LogFields) => write("warn", event, fields),
  error: (event: string, fields?: LogFields) => write("error", event, fields),
};
