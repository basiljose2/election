import { describe, expect, it } from "vitest";
import { scrubEvent, scrubText, scrubValue, type MonitoringEvent } from "./scrub";

const CANDIDATE = "3f2b8c1e-5d4a-4b7e-9a61-0c2d4e6f8a10";
const CAST_TOKEN = "Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4";

/** An error event of a failed cast, carrying everything a careless integration would attach. */
const castError: MonitoringEvent = {
  message: `cast failed for candidate ${CANDIDATE}`,
  request: {
    url: `https://vote.example/terminal/api/cast?token=${CAST_TOKEN}`,
    method: "POST",
    data: JSON.stringify({
      castToken: CAST_TOKEN,
      answers: [{ postId: "p", candidateIds: [CANDIDATE] }],
    }),
    cookies: { evm_terminal: CAST_TOKEN },
    headers: { cookie: `evm_terminal=${CAST_TOKEN}`, authorization: "Bearer x" },
    query_string: `token=${CAST_TOKEN}`,
  },
  exception: {
    values: [{ type: "Error", value: `duplicate key for ${CANDIDATE} with ${CAST_TOKEN}` }],
  },
  extra: {
    boothId: "booth-1",
    errorCode: "cast_failed",
    answers: [{ postId: "p", candidateIds: [CANDIDATE] }],
    nested: { choice: CANDIDATE, status: 500 },
  },
  contexts: { cast: { castToken: CAST_TOKEN, route: "/terminal/api/cast" } },
  breadcrumbs: [{ message: `selected ${CANDIDATE}`, data: { candidate_id: CANDIDATE, step: 2 } }],
  user: { id: "someone", email: "po@example.test" },
};

describe("monitoring scrubbing", () => {
  it("a forced cast error leaves no choice, token, cookie or user data in the event", () => {
    const text = JSON.stringify(scrubEvent(castError));
    expect(text).not.toContain(CANDIDATE);
    expect(text).not.toContain(CAST_TOKEN);
    expect(text).not.toMatch(
      /candidateIds|castToken|evm_terminal|authorization|someone|po@example/,
    );
    expect(text).not.toMatch(/answers|choice/);
  });

  it("keeps what an operator needs: the route, method, booth and error code", () => {
    const event = scrubEvent(castError);
    expect(event.request).toEqual({ url: "/terminal/api/cast", method: "POST" });
    expect(event.extra).toMatchObject({
      boothId: "booth-1",
      errorCode: "cast_failed",
      nested: { status: 500 },
    });
    expect(event.contexts).toEqual({ cast: { route: "/terminal/api/cast" } });
    expect(event.exception?.values?.[0]?.type).toBe("Error");
    expect(event.message).toBe("cast failed for candidate <id>");
  });

  it("masks identifiers and long tokens in free text, and bounds its length", () => {
    expect(scrubText(`a ${CANDIDATE} b ${CAST_TOKEN}`)).toBe("a <id> b <token>");
    expect(scrubText("word ".repeat(200))).toHaveLength(300);
  });

  it("drops forbidden keys at any depth and in arrays", () => {
    expect(
      scrubValue({ a: [{ selection: 1, keep: 2 }], b: { c: { nota: true, d: "ok" } } }),
    ).toEqual({ a: [{ keep: 2 }], b: { c: { d: "ok" } } });
  });
});
