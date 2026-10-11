import { describe, expect, it } from "vitest";
import { clientKey, createRateLimiter } from "./rate-limit";

describe("rate limiter", () => {
  it("allows 60 requests per minute and refuses the 61st until the window resets", () => {
    let time = 1_000_000;
    const limiter = createRateLimiter({ limit: 60, windowMs: 60_000, now: () => time });

    for (let i = 1; i <= 60; i++) expect(limiter.check("1.2.3.4").allowed).toBe(true);
    const refused = limiter.check("1.2.3.4");
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(limiter.check("1.2.3.4").allowed).toBe(false);

    time += 59_000;
    expect(limiter.check("1.2.3.4").allowed).toBe(false);
    time += 1_000;
    expect(limiter.check("1.2.3.4").allowed).toBe(true);
  });

  it("counts each client separately", () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => 0 });
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
    expect(limiter.check("b").allowed).toBe(true);
  });

  it("bounds memory by dropping the oldest clients", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0, maxKeys: 3 });
    for (const key of ["a", "b", "c", "d"]) limiter.check(key);
    // "a" was dropped, so it starts a fresh window instead of being refused.
    expect(limiter.check("a").allowed).toBe(true);
  });

  it("takes the first forwarded address as the client", () => {
    const headers = new Headers({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" });
    expect(clientKey(headers)).toBe("9.9.9.9");
    expect(clientKey(new Headers())).toBe("local");
  });
});
