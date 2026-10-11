-- Booth close and reconciliation: signed Booth Tallies, the sealed integrity digest and the
-- reconciliation record.
--
-- Secrecy model (see openspec: booth-close-reconciliation):
--   * Everything that has to READ Vote Selections to check them runs inside SECURITY DEFINER
--     functions owned by vote_reader (like mock_counts / election_tally). They return only
--     totals, flags and hashes: never a per-candidate or NOTA count.
--   * Ed25519 signatures cannot be verified by core Postgres, so the digest uses pgsodium's
--     crypto_sign_verify_detached against the Election's PUBLIC key.
--   * booth_tallies and reconciliation_runs are append-only, like audit_events.

-- The schema must exist first: a fresh database (and hosted projects) do not have it.
create schema if not exists pgsodium;
create extension if not exists pgsodium with schema pgsodium;

-- ---------------------------------------------------------------------------------------
-- What vote_reader needs to see to run the checks
-- ---------------------------------------------------------------------------------------

grant usage on schema pgsodium to vote_reader;
grant execute on function pgsodium.crypto_sign_verify_detached(bytea, bytea, bytea)
  to vote_reader;

-- The booth's frozen Ballot Definition (public after freeze) and the Election's PUBLIC key.
grant select on public.ballot_definitions to vote_reader;
grant select (election_id, public_key) on public.election_signing_keys to vote_reader;
create policy ballot_definitions_vote_reader_select on public.ballot_definitions
  for select to vote_reader using (true);
create policy election_signing_keys_vote_reader_select on public.election_signing_keys
  for select to vote_reader using (true);
grant select on public.booths to vote_reader;
create policy booths_vote_reader_select on public.booths
  for select to vote_reader using (true);

-- ---------------------------------------------------------------------------------------
-- The integrity digest of a CLOSED booth
-- ---------------------------------------------------------------------------------------

-- Replaces the placeholder digest of ballot-casting-core (row count + one hash).
drop function public.booth_integrity_digest(uuid);

-- Returns one jsonb document:
--   { selection_rows, merkle_root, bad_signatures, unmapped_rows,
--     posts: [ { post_id, seats, answers, divisible } ] }
-- `answers` is candidate rows / seats + NOTA rows, computed here, so the split between
-- Candidates and NOTA never leaves the database. The Merkle root is the one specified by
-- docs: leaf = SHA-256(0x00 || canonical_selection_json || signature), parent =
-- SHA-256(0x01 || left || right), leaves ordered by selection id, an odd last node promoted.
create function public.booth_integrity_digest(p_booth_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_state text;
  v_election uuid;
  v_pubkey bytea;
  v_posts jsonb;
  v_rows bigint;
  v_pairs jsonb;
  v_bad bigint;
  v_unmapped bigint;
  v_level bytea[];
  v_next bytea[];
  v_post jsonb;
  v_result jsonb := '[]'::jsonb;
  v_cand bigint;
  v_nota bigint;
  v_seats int;
  i int;
begin
  select s.state::text, b.election_id
    into v_state, v_election
    from public.booth_states s
    join public.booths b on b.id = s.booth_id
   where s.booth_id = p_booth_id;
  if v_state is null or v_state not in ('closed', 'sealed') then
    raise exception 'the integrity digest is available only after the booth is closed'
      using errcode = '42501';
  end if;

  select decode(translate(k.public_key, '-_', '+/') || '=', 'base64')
    into v_pubkey
    from public.election_signing_keys k
   where k.election_id = v_election;

  -- The booth's current Ballot Definition: the contested Posts it is mapped to.
  select (d.canonical_json::jsonb) -> 'posts'
    into v_posts
    from public.ballot_definitions d
    join public.elections e on e.id = d.election_id and e.freeze_count = d.freeze_no
   where d.election_id = v_election and d.booth_id = p_booth_id;
  v_posts := coalesce(v_posts, '[]'::jsonb);

  -- One row per real Vote Selection: its canonical content (key order as the signer's
  -- canonical JSON), whether its signature verifies, and its Merkle leaf. Only aggregates
  -- leave this query: the leaves in id order, and (Post, is NOTA) pairs with no ids.
  with r as (
    select v.id,
           v.post_id,
           v.is_nota,
           sha256('\x00'::bytea || convert_to(m.msg, 'UTF8') || convert_to(v.signature, 'UTF8'))
             as leaf,
           coalesce(
             v_pubkey is not null and pgsodium.crypto_sign_verify_detached(
               decode(translate(v.signature, '-_', '+/') || '==', 'base64'),
               convert_to(m.msg, 'UTF8'),
               v_pubkey),
             false) as sig_ok
      from public.vote_selections v
     cross join lateral (
       select format(
         '{"booth_id":"%s","candidate_id":%s,"election_id":"%s","id":"%s","is_mock":false,'
         '"is_nota":%s,"mock_round":null,"post_id":"%s"}',
         v.booth_id,
         coalesce('"' || v.candidate_id::text || '"', 'null'),
         v.election_id, v.id, v.is_nota::text, v.post_id) as msg
     ) m
     where v.booth_id = p_booth_id and not v.is_mock
  )
  select count(*),
         count(*) filter (where not r.sig_ok),
         coalesce(array_agg(r.leaf order by r.id::text), '{}'::bytea[]),
         coalesce(jsonb_agg(jsonb_build_array(r.post_id, r.is_nota)), '[]'::jsonb)
    into v_rows, v_bad, v_level, v_pairs
    from r;

  select count(*)
    into v_unmapped
    from jsonb_array_elements(v_pairs) pair
   where not exists (
     select 1 from jsonb_array_elements(v_posts) p
      where (p ->> 'post_id') = (pair ->> 0));

  for v_post in select * from jsonb_array_elements(v_posts) loop
    v_seats := (v_post ->> 'seats')::int;
    select count(*) filter (where (pair ->> 1)::boolean = false),
           count(*) filter (where (pair ->> 1)::boolean = true)
      into v_cand, v_nota
      from jsonb_array_elements(v_pairs) pair
     where (pair ->> 0) = (v_post ->> 'post_id');
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'post_id', v_post ->> 'post_id',
      'seats', v_seats,
      'answers', v_cand / v_seats + v_nota,
      'divisible', v_cand % v_seats = 0));
  end loop;

  if coalesce(array_length(v_level, 1), 0) = 0 then
    v_level := array[sha256(''::bytea)];
  end if;
  while array_length(v_level, 1) > 1 loop
    v_next := '{}'::bytea[];
    i := 1;
    while i <= array_length(v_level, 1) loop
      if i < array_length(v_level, 1) then
        v_next := v_next || sha256('\x01'::bytea || v_level[i] || v_level[i + 1]);
      else
        v_next := v_next || v_level[i];
      end if;
      i := i + 2;
    end loop;
    v_level := v_next;
  end loop;

  return jsonb_build_object(
    'selection_rows', v_rows,
    'merkle_root', encode(v_level[1], 'hex'),
    'bad_signatures', v_bad,
    'unmapped_rows', v_unmapped,
    'posts', v_result);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Booth Tallies: one signed, immutable record per closed booth
-- ---------------------------------------------------------------------------------------

create table public.booth_tallies (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null,
  booth_id uuid not null,
  status text not null check (status in ('pass', 'failed')),
  -- The signed document exactly as signed (canonical JSON), its SHA-256 and the Ed25519
  -- signature (base64url) by the Election's key. It holds totals and hashes only.
  canonical_json text not null,
  tally_hash text not null check (tally_hash ~ '^[0-9a-f]{64}$'),
  signature text not null check (signature ~ '^[A-Za-z0-9_-]{86}$'),
  created_at timestamptz not null default now(),
  constraint booth_tallies_one_per_booth unique (booth_id),
  constraint booth_tallies_hash_matches
    check (tally_hash = encode(sha256(convert_to(canonical_json, 'UTF8')), 'hex')),
  constraint booth_tallies_booth_fk foreign key (booth_id, election_id)
    references public.booths (id, election_id)
);

create trigger booth_tallies_no_update_delete
  before update or delete on public.booth_tallies
  for each row execute function public.forbid_append_only_mutation();
create trigger booth_tallies_no_truncate
  before truncate on public.booth_tallies
  for each statement execute function public.forbid_append_only_mutation();

-- ---------------------------------------------------------------------------------------
-- Reconciliation runs (the stored report; every run is also an Audit Event)
-- ---------------------------------------------------------------------------------------

create table public.reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references public.elections (id),
  run_by uuid references public.staff (user_id),
  run_at timestamptz not null default now(),
  -- True when no election-wide check failed (per-Post failures are inside `report`).
  election_checks_passed boolean not null,
  -- Totals, flags and hashes only; no per-candidate counts.
  report jsonb not null check (jsonb_typeof(report) = 'object')
);

create index reconciliation_runs_election_idx
  on public.reconciliation_runs (election_id, run_at desc);

create trigger reconciliation_runs_no_update_delete
  before update or delete on public.reconciliation_runs
  for each row execute function public.forbid_append_only_mutation();
create trigger reconciliation_runs_no_truncate
  before truncate on public.reconciliation_runs
  for each statement execute function public.forbid_append_only_mutation();

-- ---------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------

grant create on schema public to vote_reader;
alter function public.booth_integrity_digest(uuid) owner to vote_reader;
revoke create on schema public from vote_reader;

revoke all on function public.booth_integrity_digest(uuid) from public;
grant execute on function public.booth_integrity_digest(uuid) to app_server;

revoke all on public.booth_tallies, public.reconciliation_runs
  from public, anon, authenticated, service_role, app_migrator;
grant select, insert on public.booth_tallies to app_server;
grant select, insert on public.reconciliation_runs to app_server;

alter table public.booth_tallies enable row level security;
alter table public.reconciliation_runs enable row level security;

create policy booth_tallies_app_server_select on public.booth_tallies
  for select to app_server using (true);
create policy booth_tallies_app_server_insert on public.booth_tallies
  for insert to app_server with check (true);
create policy reconciliation_runs_app_server_select on public.reconciliation_runs
  for select to app_server using (true);
create policy reconciliation_runs_app_server_insert on public.reconciliation_runs
  for insert to app_server with check (true);
