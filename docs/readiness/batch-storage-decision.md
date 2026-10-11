# Decision: randomised batch storage of Vote Selections

**Status: not enabled (decision recorded; revisit with the production-like load test).**

## The risk it would reduce

`vote_selections` rows have random ids and carry no timestamp, serial or session reference,
so nothing in a row says when it was written. The remaining side channel is the **physical
order** of rows in the table (insertion order within the heap, `ctid`): someone with raw
database access who also knows the order in which voters cast ballots could line up the two.
Ballot answers are written together (all rows of one ballot are adjacent, in a random order
within the ballot), so the pattern is booth-level adjacency, not per-voter identification
without outside knowledge.

## The option

Write Selections to an unlogged holding table and move them into `vote_selections` in random
order, in the same transaction that closes the booth and creates its tally.

## Why it is off

1. **It moves the secrecy boundary, it does not remove the trust.** Until the booth closes,
   the holding table has the same adjacency, so the benefit applies only after close.
2. **It adds a failure mode on the casting path.** An unlogged table is truncated by a
   database crash, which would lose accepted votes before close: unacceptable for votes
   already acknowledged to the voter. A logged holding table removes that risk but loses the
   write-throughput reason for it.
3. **The decision rule in the design was: enable only if the load test shows no latency
   regression.** The release load test (`docs/readiness/load-test.md`) has not been run on a
   production-like deployment yet, so the condition is not met.
4. **The residual risk is bounded.** An attacker needs raw database access (which the
   application role and the API roles do not have; see the ASVS checklist, V4.4) plus an
   independent record of cast order. Booth-wise results are published anyway, so adjacency
   reveals nothing beyond what a booth's published count already does, unless the booth is
   very small.

## What to do if it is enabled later

- Keep the holding table **logged**.
- Move rows at close with `order by random()` from a CSPRNG-seeded query, inside the tally
  transaction, and have the Merkle root computed over the moved rows (already sorted by id).
- Re-run the casting secrecy test (`tests/integration/casting.test.ts`, Spearman rank
  correlation of insertion order vs ballot order) and expect the correlation to be ~0 for
  rows read from the table.
- Repeat the 60-minute load test; require no p95 regression.
