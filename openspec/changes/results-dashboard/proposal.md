## Why

When polling finishes, the Returning Officer must complete all polls, confirm integrity,
and declare results. The results then need to be shown as a clear dashboard: votes
polled, winners per Post, margins, NOTA, ties and booth-wise figures. The declared
result must be final, signed and reproducible.

Depends on: `booth-close-reconciliation`. Can be built in parallel with
`transparency-portal`.

## What Changes

- Returning Officer election dashboard: live turnout and booth states during polling, a "Complete all polls" checklist, the reconciliation report, and a Declare action
- Result computation: top-N winners per Post, NOTA excluded from ranking, ties at the cut-off flagged and never resolved, uncontested Posts elected unopposed, Posts that failed reconciliation withheld
- An immutable, signed Result snapshot created atomically with the Election's move to Results Declared
- Results dashboard: summary tiles, per-Post cards with charts, winners, margins, NOTA and tie badges, a booth-wise table, and PDF/CSV/JSON exports

## Capabilities

### New Capabilities
- `results-declaration`: completing polls, computing and declaring results, and presenting them as a dashboard

### Modified Capabilities
- none

## Non-goals

- Public results pages and the verification bundle (`transparency-portal`)
- Tie resolution or re-polls (always handled outside the system)
- Turnout percentages (the system has no voter roll)

## Impact

- New append-only tables results and result_items; RO dashboard routes; PDF generation
