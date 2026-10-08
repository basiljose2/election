/**
 * Canonical JSON used for Audit Event hashing (see docs/AUDIT_FORMAT.md).
 *
 * - Object keys sorted by UTF-16 code units (as RFC 8785 / JCS), no duplicate keys.
 * - No insignificant whitespace; strings escaped as JSON.stringify does; UTF-8 output.
 * - Numbers must be safe integers. Timestamps are ISO-8601 UTC strings, never Dates.
 * - `undefined`, functions, symbols, bigint, NaN/Infinity and non-plain objects are rejected
 *   so that a value always has exactly one canonical encoding.
 *
 * tools/verifier/verify-audit.mjs carries an independent copy of these rules.
 */

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function canonicalJson(value: unknown): string {
  return encode(value, "$");
}

function encode(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new TypeError(`canonicalJson: ${path} must be a safe integer, got ${value}`);
      }
      return Object.is(value, -0) ? "0" : String(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item, i) => encode(item, `${path}[${i}]`)).join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`canonicalJson: ${path} must be a plain object`);
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      return `{${keys
        .map((key) => `${JSON.stringify(key)}:${encode(record[key], `${path}.${key}`)}`)
        .join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: ${path} has unsupported type ${typeof value}`);
  }
}
