## Context

Per-candidate counts only become readable through `election_tally()` once the Election
is Polling Completed, and only the declaration command calls it. Reconciliation comes
from `booth-close-reconciliation`.

## Goals / Non-Goals

**Goals:**
- Deterministic, reproducible results computed once and frozen

**Non-Goals:**
- A "preview before declaring" mode. Counts are revealed at the same moment they are
  declared, so nobody can see results early and delay or influence the declaration.

## Decisions

- **Pure winner function.** `computePostResult(post, counts)` is a pure TypeScript
  function shared with the public verifier. It is fully covered by table-driven tests,
  including every spec scenario and property-based tests (for example, Elected count ≤
  seats, and tied + elected covers all seats).
- **Declaration transaction.**
  1. Lock the election row.
  2. Re-run reconciliation.
  3. Call `election_tally()`.
  4. Compute the results.
  5. Insert `results` and `result_items` (append-only).
  6. Sign, audit, change the status, commit.
- **Dashboard data.** Read only from the stored Result snapshot, never by recounting,
  so what is displayed always equals what was signed.
- **Charts.** Horizontal bar per Post (candidates plus NOTA in a neutral colour), with
  Elected bars highlighted. Summary tiles use large numbers. The dataviz guidelines are
  followed when building.
- **PDF.** Generated on the server from the snapshot (react-pdf), deterministic layout,
  with the Result hash in the footer of every page.
- **Polling dashboard refresh.** Subscribe to an election-level signal channel (RO and
  Observers only). Fall back to polling every 5 s.

## Secrecy and integrity

The dashboard is built only from the signed snapshot. Booth-wise per-candidate figures
are standard in EVM elections (Form 20 style). In very small booths they can reveal how
individuals voted; see Risks.

## Risks / Trade-offs

- [A small booth's breakdown reveals individual votes] → Recommend in the runbook that booths should have at least about 25 voters. Booth-wise figures stay, because they are what makes the result auditable.
- [Declaration fails midway] → It is one transaction, so it either fully happens or nothing changes.
