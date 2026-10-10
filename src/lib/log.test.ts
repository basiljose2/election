import { afterEach, describe, expect, it } from "vitest";
import { logger, redact, setLogSink, type LogRecord } from "./log";

describe("log redaction", () => {
  const seen: LogRecord[] = [];
  afterEach(() => {
    seen.length = 0;
    setLogSink(null);
  });

  it("keeps only allowlisted, id- or code-shaped fields", () => {
    const { fields, dropped } = redact({
      booth_id: "6f9619ff-8b86-d011-b42d-00c04fc964ff",
      error_code: "invalid_ballot",
      issue_codes: ["wrong_count", "missing_post"],
      duration_ms: 12,
      body: { answers: [{ candidateIds: ["x"] }] },
      candidateIds: ["x"],
      answers: "x",
      message: "Candidate Asha was selected",
      error_message: "x".repeat(200),
    });
    expect(fields).toEqual({
      booth_id: "6f9619ff-8b86-d011-b42d-00c04fc964ff",
      error_code: "invalid_ballot",
      issue_codes: ["wrong_count", "missing_post"],
      duration_ms: 12,
    });
    expect(dropped).toBe(5);
  });

  it("drops an allowlisted field whose value is free text or an object", () => {
    const { fields, dropped } = redact({
      error_code: "Candidate Asha and Bilal",
      status: { nested: true },
      issue_codes: [{ a: 1 }],
    });
    expect(fields).toEqual({});
    expect(dropped).toBe(3);
  });

  it("writes redacted records to the sink", () => {
    setLogSink((record) => seen.push(record));
    logger.error("cast.error", {
      booth_id: "b1",
      error: new Error("insert ... values ('cand-1')"),
    });
    expect(seen).toEqual([
      { level: "error", event: "cast.error", fields: { booth_id: "b1" }, dropped_fields: 1 },
    ]);
    expect(JSON.stringify(seen)).not.toContain("cand-1");
  });
});
