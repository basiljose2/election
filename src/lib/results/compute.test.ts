import { describe, expect, it } from "vitest";
import {
  computePostResult,
  uncontestedResult,
  withheldResult,
  type PostInput,
  type PostResult,
} from "./compute";

const post = (seats: number, ids: string[], uncontested = false): PostInput => ({
  postId: "post",
  name: "Post",
  seats,
  uncontested,
  candidates: ids.map((id, i) => ({ id, name: `Candidate ${id}`, serial: i + 1 })),
});

const run = (
  seats: number,
  votes: Record<string, number>,
  nota = 0,
  notaEnabled = true,
): PostResult =>
  computePostResult(post(seats, Object.keys(votes)), { candidates: votes, nota }, { notaEnabled });

const outcomes = (r: PostResult) => Object.fromEntries(r.candidates.map((c) => [c.id, c.outcome]));
const idsWith = (r: PostResult, outcome: string) =>
  r.candidates.filter((c) => c.outcome === outcome).map((c) => c.id);

describe("computePostResult: spec scenarios", () => {
  it("clear winner, single seat", () => {
    const r = run(1, { A: 50, B: 40 });
    expect(r.status).toBe("elected");
    expect(idsWith(r, "elected")).toEqual(["A"]);
    expect(r.margin).toBe(10);
  });

  it("tie for a single seat: nobody elected, A and B tied, never broken", () => {
    const r = run(1, { A: 45, B: 45, C: 10 });
    expect(r.status).toBe("tie");
    expect(idsWith(r, "elected")).toEqual([]);
    expect(idsWith(r, "tied").sort()).toEqual(["A", "B"]);
    expect(r.tiedSeats).toBe(1);
    expect(outcomes(r).C).toBe("not_elected");
    expect(r.margin).toBeNull();
  });

  it("partial tie on a multi-seat post", () => {
    const r = run(3, { A: 60, B: 50, C: 40, D: 40, E: 10 });
    expect(r.status).toBe("tie");
    expect(idsWith(r, "elected")).toEqual(["A", "B"]);
    expect(idsWith(r, "tied")).toEqual(["C", "D"]);
    expect(r.tiedSeats).toBe(1);
    expect(outcomes(r).E).toBe("not_elected");
    expect(r.margin).toBe(10); // B (50) over the next, C (40)
  });

  it("all votes NOTA: every Candidate on 0 is tied", () => {
    const r = run(1, { A: 0, B: 0 }, 120);
    expect(r.status).toBe("tie");
    expect(idsWith(r, "tied")).toEqual(["A", "B"]);
    expect(r.candidates.every((c) => c.votes === 0)).toBe(true);
    expect(r.nota).toBe(120);
  });

  it("NOTA leads: the Candidate is still elected, and the Post is flagged", () => {
    const r = run(1, { A: 50, B: 30 }, 70);
    expect(idsWith(r, "elected")).toEqual(["A"]);
    expect(r.notaExceededWinner).toBe(true);
    expect(r.nota).toBe(70);
  });

  it("NOTA never wins and is not flagged when it trails every Elected Candidate", () => {
    const r = run(2, { A: 50, B: 40, C: 10 }, 30);
    expect(idsWith(r, "elected")).toEqual(["A", "B"]);
    expect(r.notaExceededWinner).toBe(false);
  });

  it("NOTA is flagged when it beats ANY elected Candidate (multi-seat)", () => {
    const r = run(2, { A: 80, B: 40, C: 10 }, 60);
    expect(idsWith(r, "elected")).toEqual(["A", "B"]);
    expect(r.notaExceededWinner).toBe(true);
  });

  it("NOTA is not reported when the Election disables it", () => {
    const r = run(1, { A: 5, B: 3 }, 0, false);
    expect(r.nota).toBeNull();
    expect(r.notaExceededWinner).toBe(false);
  });

  it("shares: answers are candidate votes / seats + NOTA", () => {
    const r = run(2, { A: 30, B: 20, C: 10 }, 5);
    expect(r.answers).toBe(30 + 5); // (30+20+10)/2 + 5
  });

  it("a tie at the cut-off between elected and a lower candidate with fewer candidates", () => {
    const r = run(2, { A: 10, B: 10 });
    expect(r.status).toBe("elected");
    expect(idsWith(r, "elected")).toEqual(["A", "B"]);
  });

  it("three-way tie for two seats", () => {
    const r = run(2, { A: 9, B: 9, C: 9 });
    expect(r.status).toBe("tie");
    expect(r.tiedSeats).toBe(2);
    expect(idsWith(r, "tied")).toEqual(["A", "B", "C"]);
  });
});

describe("uncontested and withheld Posts", () => {
  it("uncontested Candidates are Elected unopposed, with no counts", () => {
    const r = computePostResult(
      post(1, ["A"], true),
      { candidates: {}, nota: 0 },
      { notaEnabled: true },
    );
    expect(r.status).toBe("unopposed");
    expect(r.candidates).toEqual([
      expect.objectContaining({ id: "A", outcome: "unopposed", votes: null }),
    ]);
    expect(r.nota).toBeNull();
    expect(r.answers).toBeNull();
    expect(uncontestedResult(post(1, ["A"], true))).toEqual(r);
  });

  it("a withheld Post carries no counts at all", () => {
    const r = withheldResult(post(1, ["A", "B"]), "integrity check failed");
    expect(r.status).toBe("withheld");
    expect(r.withheldReason).toBe("integrity check failed");
    expect(r.candidates.map((c) => c.votes)).toEqual([null, null]);
    expect(r.nota).toBeNull();
    expect(r.answers).toBeNull();
    expect(JSON.stringify(r)).not.toMatch(/"votes":\d/);
  });
});

/** A tiny deterministic generator, so "property" runs are reproducible without a library. */
function lcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe("computePostResult: properties", () => {
  it("holds for 2,000 random Posts", () => {
    const random = lcg(20261013);
    for (let run = 0; run < 2000; run++) {
      const candidateCount = 2 + Math.floor(random() * 7);
      const seats = 1 + Math.floor(random() * Math.min(4, candidateCount - 1));
      const ids = Array.from({ length: candidateCount }, (_, i) => `c${i}`);
      // Small vote range on purpose, so ties are common.
      const votes = Object.fromEntries(ids.map((id) => [id, Math.floor(random() * 6)]));
      const nota = Math.floor(random() * 8);
      const r = computePostResult(
        post(seats, ids),
        { candidates: votes, nota },
        { notaEnabled: true },
      );

      const elected = r.candidates.filter((c) => c.outcome === "elected");
      const tied = r.candidates.filter((c) => c.outcome === "tied");

      // Never more Elected than seats; elected + open (tied) seats never exceed them.
      expect(elected.length).toBeLessThanOrEqual(seats);
      expect(elected.length + r.tiedSeats).toBe(seats);
      // A tie group is always bigger than the seats it competes for, and all on one count.
      if (r.status === "tie") {
        expect(tied.length).toBeGreaterThan(r.tiedSeats);
        expect(new Set(tied.map((c) => c.votes)).size).toBe(1);
        expect(r.tiedSeats).toBeGreaterThan(0);
      } else {
        expect(tied).toEqual([]);
        expect(elected.length).toBe(seats);
      }
      // Every Elected Candidate has at least as many votes as every non-Elected one.
      const minElected = Math.min(...elected.map((c) => c.votes!), Infinity);
      for (const c of r.candidates.filter((x) => x.outcome !== "elected")) {
        expect(c.votes!).toBeLessThanOrEqual(minElected);
      }
      // NOTA is never a Candidate and never Elected.
      expect(r.candidates.map((c) => c.id).sort()).toEqual([...ids].sort());
      // The result does not depend on the order candidates are supplied in.
      const shuffled = [...ids].reverse();
      const again = computePostResult(
        post(seats, shuffled),
        { candidates: votes, nota },
        { notaEnabled: true },
      );
      expect(again.status).toBe(r.status);
      expect(Object.fromEntries(again.candidates.map((c) => [c.id, c.outcome]))).toEqual(
        Object.fromEntries(r.candidates.map((c) => [c.id, c.outcome])),
      );
    }
  });
});
