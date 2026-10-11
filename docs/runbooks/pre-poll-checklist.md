# Pre-poll checklist

Print this and tick it. "RO" is the Returning Officer, "PO" the Presiding Officer of a booth,
"SA" the Super Admin.

## Weeks before (RO / SA)

- [ ] **Rehearse on a clone.** Clone the real election (Elections → Clone), then run the
      whole flow on the clone: setup, freeze, pair, mock poll, vote, close, declare, verify
      (`docs/runbooks/dress-rehearsal.md`). Nothing from the clone touches the real election.
- [ ] **Signing key material.** `VOTE_SIGNING_MASTER_KEY` is 32 random bytes, generated once
      on a trusted machine (`openssl rand -base64 32`), stored only as a Vercel environment
      variable and in the sealed offline copy held by the SA. It is never emailed, logged or
      committed. Losing it makes the election's signing keys unreadable.
- [ ] **Restore drill done** within the last 30 days and its record attached
      (`docs/runbooks/restore-drill.md`).
- [ ] **Release gate**: ASVS checklist ticked (`docs/security/asvs.md`), `npm run check:audit`
      clean, `scripts/pentest/run.mjs` all PASS against the deployment, load-test report
      attached.
- [ ] **Staff**: every PO has an account, is assigned to exactly their booth, and has signed
      in once from the booth's Master Terminal device. RO and SA have enrolled TOTP.
- [ ] **Booth sizes**: booths expected to see fewer than ~25 voters are known to the RO
      (booth-wise results can reveal individual votes in very small booths).

## Setup (RO) and freeze

- [ ] Posts, seats, candidates (serial order, photos, symbols), NOTA setting reviewed by the
      candidates' representatives on paper.
- [ ] Every Post mapped to at least one booth; every booth has a PO.
- [ ] **Freeze.** Note the **Setup Hash** shown on the public election page and read it out
      or print it for the candidates' agents.

## The day before (PO, with RO on call)

- [ ] Devices charged and on wired power; kiosk acceptance list passed
      (`docs/runbooks/kiosk-configuration.md`).
- [ ] **Backup hotspot** (phone or MiFi with data) tested from the booth position, saved on
      both devices.
- [ ] Printed copies of this checklist, the incident runbook and the RO's phone number at
      the booth.

## At the booth, before the poll opens (PO)

1. [ ] Sign in on the Master Terminal device, open `/master`, **Register this device**.
2. [ ] Generate a pairing code; on the kiosk enter it; compare the **device id**; Confirm.
3. [ ] Tap **Activate** on the kiosk; hear the test tone.
4. [ ] **Start mock poll.** The MOCK POLL banner shows.
5. [ ] Cast **two or three test ballots** (including one with NOTA if enabled and one that
       you Change from the review screen). Each ends with the long beep and a locked screen.
6. [ ] Press Ballot, then **Cancel** with a reason on one test ballot; the cancelled count
       rises and the kiosk locks without a beep.
7. [ ] Open **Mock result**: the totals equal the test ballots cast.
8. [ ] **Clear mock poll** (confirm). Optionally **Repeat** if the first run had problems.
9. [ ] **Open poll**: the confirmation says the real count is 0; enter your password.
10. [ ] The PO, an agent and the RO see "Poll open"; the public status board shows the booth
        as Polling open with 0 ballots.

The booth is now live. Keep the Master Terminal locked (it locks itself after 5 minutes)
and the kiosk unattended only behind the privacy screen.
