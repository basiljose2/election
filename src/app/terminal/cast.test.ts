import { describe, expect, it, vi } from "vitest";
import { BACKOFF_MAX_MS, BACKOFF_START_MS, castWithRetry, type CastRequest } from "./cast";

const request: CastRequest = {
  castToken: "t".repeat(43),
  idempotencyKey: "k".repeat(32),
  answers: [{ postId: "p", candidateIds: ["a"] }],
};

function harness(responses: Array<Response | Error>) {
  const bodies: string[] = [];
  const delays: number[] = [];
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  });
  const controller = new AbortController();
  return {
    bodies,
    delays,
    fetchMock,
    controller,
    deps: {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async (ms: number): Promise<void> => {
        delays.push(ms);
      },
      signal: controller.signal,
    },
  };
}

const reply = (status: number, body: object = {}) => Response.json(body, { status });

describe("castWithRetry", () => {
  it("records on 200", async () => {
    const h = harness([reply(200, { status: "cast" })]);
    expect(await castWithRetry(request, h.deps)).toEqual({ kind: "recorded" });
    expect(h.delays).toEqual([]);
  });

  it("retries network errors without limit, with the same body and growing backoff", async () => {
    const failures = Array.from({ length: 8 }, () => new TypeError("network"));
    const h = harness([...failures, reply(200)]);
    expect(await castWithRetry(request, h.deps)).toEqual({ kind: "recorded" });

    expect(h.fetchMock).toHaveBeenCalledTimes(9);
    expect(new Set(h.bodies).size).toBe(1); // same idempotency key every time
    expect(h.delays).toEqual([BACKOFF_START_MS, 1000, 2000, 4000, 4000, 4000, 4000, 4000]);
    expect(Math.max(...h.delays)).toBe(BACKOFF_MAX_MS);
  });

  it("retries server errors", async () => {
    const h = harness([reply(500, { status: "error" }), reply(503), reply(200)]);
    expect(await castWithRetry(request, h.deps)).toEqual({ kind: "recorded" });
    expect(h.fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reports a cancelled session as cancelled, not as a failure to retry", async () => {
    const h = harness([reply(409, { status: "rejected", reason: "cancelled" })]);
    expect(await castWithRetry(request, h.deps)).toEqual({ kind: "cancelled" });
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [409, { status: "rejected", reason: "already_finished" }],
    [422, { status: "invalid", issues: [] }],
    [401, { error: "unauthenticated" }],
  ])("treats %i as a definitive refusal", async (status, body) => {
    const h = harness([reply(status, body)]);
    expect(await castWithRetry(request, h.deps)).toEqual({ kind: "refused" });
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops retrying when aborted", async () => {
    const h = harness([new TypeError("network"), new TypeError("network")]);
    h.deps.sleep = async () => h.controller.abort();
    expect(await castWithRetry(request, h.deps)).toEqual({ kind: "aborted" });
  });
});
