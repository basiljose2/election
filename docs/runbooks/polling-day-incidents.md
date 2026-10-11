# Polling-day incident runbook

Golden rules: **never let a voter's ballot be silently lost or duplicated, and never type a
voter's choices anywhere.** When in doubt, cancel the pending ballot and issue a new one: a
cancelled ballot is counted as cancelled and stores no vote.

Each procedure says what the system does by itself so you know what you do **not** need to do.

## 1. Voting Terminal fails (frozen, crashed, broken)

The server is the source of truth; the kiosk holds a voter's choices only in memory.

1. **If a voter is mid-ballot**, apologise and take them away from the screen. On the Master
   Terminal press **Cancel pending ballot**, choose _Terminal fault_, confirm. (Their
   choices are gone: the ballot stored nothing.)
2. On the Master Terminal, **Replace the Voting Terminal**: Generate pairing code.
3. On the replacement device open `/terminal`, enter the code, compare the **device id**,
   then Confirm on the Master Terminal.
4. Tap **Activate** on the replacement; hear the tone.
5. Press **Ballot** for the next voter. Continue. The failed device's credential is revoked
   automatically, so it can no longer cast.

**Not needed:** closing the poll, telling the RO (unless it happens twice), re-counting.
The audit log records the cancellation, the pairing and the revocation.

## 2. Master Terminal fails

1. Take the Master Terminal's tablet/laptop out of service. **Do not** let anyone use its
   login on two devices at once.
2. On a spare device the PO signs in and opens `/master` → **Register this device**. This
   makes it the booth's only Master Terminal and revokes the old one.
3. Registration is refused while a ballot is **pending**. Two cases:
   - the voter is still at the kiosk: let them finish. The cast completes the session and the
     refusal goes away.
   - the voter has left a pending ballot and the old Master is dead: a pending ballot can be
     cancelled **only from the booth's registered Master Terminal**, so call the RO, who
     can **force-close** this booth (with a written reason). That cancels the pending ballot
     and closes the booth; see section 5. (Known gap: there is no RO "cancel pending ballot"
     command. If this case matters to you, raise it before polling day.)
4. After registering, pair the existing kiosk again only if it shows "no longer paired";
   otherwise it keeps working.

## 3. Network outage

- **Kiosk:** a vote in progress keeps showing _Recording your vote…_ and retries with the
  same key until the network returns, then records exactly once. **Do not** press anything
  or reload the page while that message shows.
- **Switch to the backup hotspot** on the kiosk and the Master Terminal if the outage lasts
  more than a few minutes. Reconnect, and both screens catch up on their own.
- The Master Terminal shows the Voting Terminal as **offline** after 30 s without
  heartbeats, and disables **Ballot** with the reason. Do not issue ballots while offline.
- If the outage outlasts the poll, the RO decides on extending hours **outside the system**;
  the booth stays Open and nothing is lost.

## 4. Power loss

1. Restore power; start the devices.
2. **Kiosk:** open `/terminal`, tap **Activate**. If a ballot was pending, the kiosk shows
   its first screen again for the same voter (the voter starts the ballot over; nothing was
   stored). If the voter has left, **Cancel pending ballot** on the Master Terminal.
3. **Master Terminal:** sign in again if asked; the screen shows the state from the server.
4. Check the counts against the paper register once the booth is running again.

## 5. The Presiding Officer is unreachable

1. The RO opens the election dashboard, finds the booth, and uses **Force close** with a
   written reason (the PO's absence). This cancels any pending ballot, closes the booth and
   creates its Booth Tally; the RO's re-authentication is required.
2. A booth can be force-closed only while it is Open. The record names the RO and the reason.
3. If a replacement PO is assigned and the booth should keep polling, **do not** force
   close; the replacement signs in and registers a new Master Terminal (section 2).

## 6. Anything else

- _The kiosk shows the "Return to full screen" overlay:_ tap it. Choices are kept.
- _The kiosk beeps nothing after a vote:_ the vote is recorded only if the beep played **and**
  the message "Your vote has been recorded" showed; if neither did, check the Master
  Terminal's count before issuing another ballot.
- _A voter says the screen "went back to waiting":_ the ballot was cancelled or the session
  ended; check the Master Terminal's cancelled count and issue a new ballot.
- _Count mismatch with the paper register at close:_ **do not** edit anything. Close the
  poll, let the Booth Tally be created, and give the RO both numbers; a mismatch is reported,
  never repaired (`docs/runbooks/post-poll-archiving.md`).

## Escalation

PO → RO (phone) → SA. Record every incident in the paper log with the time, the booth and
what was done; the system's audit log is the other half of the record.
