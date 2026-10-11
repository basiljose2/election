# Public transparency

Everything under `/public` is readable without a login, is read only, and is served from the
explicit `public_*` database views (never from a base table).

## Routes

| Path                                | Content                                                          | Caching                            |
| ----------------------------------- | ---------------------------------------------------------------- | ---------------------------------- |
| `/public`                           | Elections whose setup has been frozen                            | none (HTML, per-request CSP nonce) |
| `/public/elections/:id`             | Posts, candidates, booths, Setup Hash, public key, Booth Tallies | none                               |
| `/public/elections/:id/status`      | Live booth states and turnout totals                             | page none; data below              |
| `/public/api/elections/:id/status`  | JSON for the board                                               | `s-maxage=10`                      |
| `/public/api/elections/:id/tallies` | Booth Tallies (hash, Merkle root, signature)                     | `s-maxage=30`                      |
| `/public/api/elections/:id/result`  | The signed Result (after declaration)                            | immutable once declared            |
| `/public/elections/:id/results`     | The Result as a read-only dashboard                              | none                               |
| `/public/elections/:id/bundle`      | The verification bundle (zip)                                    | immutable, keyed by its hash       |
| `/verify`                           | In-browser verifier (File API, no network)                       | none                               |

A Draft Election answers 404 everywhere, exactly like an unknown one.

## Rate limiting

Two layers, both returning `429` with `Retry-After`:

1. **Vercel Firewall** (first line): a rate-limit rule on path prefix `/public`, 60 requests
   per minute per IP, action "Deny" (or "Rate limit") for the rest of the window.
2. **Application fallback** (`src/proxy.ts`, `src/lib/security/rate-limit.ts`): the same
   limit per client address and instance. Override with `PUBLIC_RATE_LIMIT_PER_MINUTE`.

Only `/public/*` is limited. Casting, terminals and staff routes are never affected.

## Verification bundle

Created right after a declaration commits (and on first request if that step did not run); the
same bytes are served ever after. Its README documents every format and algorithm. Verify it
with the page at `/verify`, or offline:

```
node tools/verifier/verify-bundle.mjs verification-bundle-XXXX.zip
```

The verifier (`tools/verifier/lib/bundle.mjs`) has no dependencies and no network access, and
re-implements the canonical JSON, signature, Merkle and winner rules independently of the
server. Because it lives in the same repository as the server, an outside party should
re-implement it from the bundle README instead of trusting this copy alone.

## What the bundle reveals

Vote Selections are published as unlinkable rows (random id, Post, Candidate or NOTA,
signature), sorted by id. They reveal what the booth-wise counts already reveal, and nothing
about when, where or by whom a vote was cast. Very small booths make booth-wise figures
sensitive; see the runbook for the minimum booth size.
