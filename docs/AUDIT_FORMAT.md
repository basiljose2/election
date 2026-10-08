# Audit export format (`campus-evm-audit-export/v1`)

Every state-changing action and every denied authorization attempt is recorded as an
Audit Event. Events form one hash chain per Election, plus a **system** chain for events
that belong to no Election (staff management, sign-in, denied attempts). The database
rejects `UPDATE`, `DELETE` and `TRUNCATE` on events through privileges and triggers, and
it rejects any insert that does not extend the head of its chain.

## Getting an export

`GET /api/audit/<election-id>/export` or `GET /api/audit/system/export`

- Super Admin: any chain.
- Returning Officer or Observer: their Election's chain.

## Document

```json
{
  "format": "campus-evm-audit-export/v1",
  "algorithm": { "...": "a short description of the rules below" },
  "election_id": "<uuid or null for the system chain>",
  "genesis": "<hex>",
  "event_count": 42,
  "head_hash": "<hex hash of the last event, or genesis if empty>",
  "events": [
    {
      "election_id": "<uuid or null>",
      "seq": 1,
      "prev_hash": "<hex>",
      "hash": "<hex>",
      "payload": {
        "event_type": "staff.role_assigned",
        "actor": { "user_id": "<uuid or null>", "role": "super_admin", "terminal_id": null },
        "target": { "type": "staff_role", "id": "<id>" },
        "before": null,
        "after": { "...": "..." },
        "detail": null,
        "occurred_at": "2026-09-30T10:00:00.123456Z"
      }
    }
  ]
}
```

Audit Events never contain candidate or NOTA choices, and nothing that links a Ballot
Session to a Vote Selection.

## Canonical JSON

- UTF-8.
- Object keys sorted by UTF-16 code units (the RFC 8785 order). No duplicate keys.
- No whitespace outside strings.
- Strings escaped as ECMAScript `JSON.stringify` does.
- Numbers are integers only (no fractions, no exponent). `-0` is written as `0`.
- Timestamps are ISO-8601 UTC strings with a `Z` suffix.

## Hashing

```
genesis(election_id) = hex(SHA-256(UTF-8("campus-evm/audit-genesis/v1:" + (election_id ?? "system"))))

hash(event) = hex(SHA-256(UTF-8(prev_hash + canonical_json({
                election_id, seq, prev_hash, payload
              }))))
```

- `prev_hash` of `seq = 1` is `genesis(election_id)`.
- `seq` runs 1, 2, 3, … with no gaps.
- Each `prev_hash` equals the previous event's `hash`.

## Verifying

`tools/verifier/verify-audit.mjs` is a standalone Node script with no dependencies outside
the Node standard library and no application imports:

```bash
node tools/verifier/verify-audit.mjs audit-<id>.json
# OK  chain <id>: 42 events, head <hash>
# FAIL chain <id>: first mismatch at seq 17: hash does not match the event content
```

It reports the first mismatching sequence number when an event is altered, removed or
reordered. An export cut short at the end is only detectable against a `head_hash`
published or recorded elsewhere, so publish the head hash when a poll closes.
