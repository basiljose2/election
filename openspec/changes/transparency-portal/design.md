## Context

Public traffic must never slow down the voting path. Vercel's CDN can cache public
responses, and the database must expose only explicit public views.

## Goals / Non-Goals

**Goals:**
- Trust nothing on the server when verifying
- Public load isolated from casting

**Non-Goals:**
- Commenting or dispute workflows

## Decisions

- **Public data access.**
  - Dedicated `public_*` views (setup, ballot definitions, booth status, booth tallies,
    results) readable by `anon`, and nothing else.
  - Vote Selections are exported only via a `vote_reader` function that raises unless
    the Election is Results Declared.
- **Caching.**
  - Status board: `s-maxage=10`.
  - Setup, tallies and results: immutable once created, so cached for a long time and
    keyed by hash.
  - The bundle is generated once at declaration, stored in Supabase Storage as a
    zip, and served from there.
- **Verifier.**
  - A workspace package `@campus-evm/verifier` with no network access. It reuses the
    canonical JSON, signature, Merkle and `computePostResult` packages, so both sides
    run the same code, and it is also tested against independent test vectors.
  - The browser page loads the zip locally (File API). The CLI prints the results as
    a table.
- **Observer feed.** Election-level signals plus fetching Audit Events after the last
  seen sequence number.
- **Rate limiting.** Vercel Firewall rate-limit rules on the `/public/*` paths, plus
  the app-level limiter as a fallback.

## Secrecy and integrity

The bundle's Vote Selections are unlinkable rows sorted by random id. They reveal
exactly what booth-wise counts already reveal. Everything published is signed or
hash-committed before publication.

## Risks / Trade-offs

- [The verifier shares code with the server, so a shared bug would pass both] → Independent test vectors written by hand in the README, and the algorithm documented so third parties can write their own verifier.
- [Supabase Storage bundle availability] → The bundle is also downloadable from the RO dashboard for offline archiving.
