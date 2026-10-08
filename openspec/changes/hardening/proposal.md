## Why

A campus election happens once and can't be rerun because of a software failure. Before
the first real election, the system needs proof that it holds up under polling-day load,
that its security controls work, that data can be restored, and that staff know exactly
what to do when a terminal, the network or a person fails.

Depends on: all previous changes.

## What Changes

- Load and soak testing of the full casting path on Vercel and Supabase
- Security review against OWASP ASVS Level 2, dependency audit, and focused penetration tests of terminal and public endpoints
- Backup and restore drill with post-restore verification
- Monitoring and alerting without vote data
- Optional randomised batch storage of Vote Selections (from the `ballot-casting-core` design)
- Operator documentation: kiosk configuration, pre-poll checklist, polling-day incident runbook, post-poll archiving
- A full dress rehearsal election, verified end to end

## Capabilities

### New Capabilities
- `operational-readiness`: performance, recoverability, monitoring and operating-procedure guarantees required before a real election

### Modified Capabilities
- none

## Non-goals

- New voter-facing or officer-facing features

## Impact

- Test tooling (k6 or Artillery), CI security scans, Supabase PITR settings, a `docs/` runbook set
