-- Public transparency: explicit read-only views for `anon`, the sealed vote export, and the
-- stored verification bundle.
--
-- * Only the public_* views are readable by `anon`, and they expose only Elections that have
--   been frozen (Draft Elections do not exist as far as they are concerned).
-- * Vote Selections leave the database only through export_booth_selections(), which raises
--   unless the Election's results have been declared.
-- * The verification bundle is created in the declaration transaction and never changes.

-- ---------------------------------------------------------------------------------------
-- Public views (definer rights: the view owner reads the base tables, the caller does not)
-- ---------------------------------------------------------------------------------------

create view public.public_elections as
  select e.id, e.name, e.description, e.polling_date, e.nota_enabled, e.status::text as status
    from public.elections e
   where e.status <> 'draft';

-- The CURRENT frozen setup (its hash is the Setup Hash).
create view public.public_setups as
  select s.election_id, s.freeze_no, s.setup_hash, s.canonical_json
    from public.setup_snapshots s
    join public.elections e on e.id = s.election_id and e.freeze_count = s.freeze_no
   where e.status <> 'draft';

create view public.public_ballot_definitions as
  select d.election_id, d.booth_id, d.freeze_no, d.definition_hash, d.canonical_json
    from public.ballot_definitions d
    join public.elections e on e.id = d.election_id and e.freeze_count = d.freeze_no
   where e.status <> 'draft';

create view public.public_signing_keys as
  select k.election_id, k.public_key
    from public.election_signing_keys k
    join public.elections e on e.id = k.election_id
   where e.status <> 'draft';

-- Booth names, states and turnout totals: no staff, terminals or per-candidate data.
create view public.public_booth_status as
  select b.id as booth_id, b.election_id, b.name, b.location,
         s.state::text as state, c.ballots_cast, c.ballots_cancelled
    from public.booths b
    join public.elections e on e.id = b.election_id
    join public.booth_states s on s.booth_id = b.id
    join public.booth_counters c on c.booth_id = b.id
   where e.status <> 'draft';

-- A Booth Tally is public as soon as it exists (when its booth closes).
create view public.public_booth_tallies as
  select t.election_id, t.booth_id, t.status, t.tally_hash, t.signature,
         t.canonical_json, t.created_at
    from public.booth_tallies t
   where exists (select 1 from public.elections e where e.id = t.election_id and e.status <> 'draft');

-- A Result exists only after declaration.
create view public.public_results as
  select r.election_id, r.result_hash, r.signature, r.canonical_json, r.declared_at
    from public.results r;

-- Supabase's default privileges would hand every new view to anon/authenticated with write
-- rights; a single-table view is auto-updatable, so that would be a write path. Read only.
revoke all on
  public.public_elections, public.public_setups, public.public_ballot_definitions,
  public.public_signing_keys, public.public_booth_status, public.public_booth_tallies,
  public.public_results
  from public, anon, authenticated, service_role, app_migrator;

grant select on
  public.public_elections, public.public_setups, public.public_ballot_definitions,
  public.public_signing_keys, public.public_booth_status, public.public_booth_tallies,
  public.public_results
  to anon, app_server;

-- ---------------------------------------------------------------------------------------
-- Sealed vote export (Results Declared only)
-- ---------------------------------------------------------------------------------------

create function public.export_booth_selections(p_election_id uuid)
returns table (
  booth_id uuid, id uuid, post_id uuid, candidate_id uuid, is_nota boolean, signature text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select e.status::text into v_status from public.elections e where e.id = p_election_id;
  if v_status is null or v_status not in ('results_declared', 'archived') then
    raise exception 'Vote Selections are exported only after results are declared'
      using errcode = '42501';
  end if;
  -- Sorted by identifier: a random uuid, so the order says nothing about when or by whom.
  return query
    select v.booth_id, v.id, v.post_id, v.candidate_id, v.is_nota, v.signature
      from public.vote_selections v
     where v.election_id = p_election_id and not v.is_mock
     order by v.booth_id, v.id::text;
end;
$$;

grant create on schema public to vote_reader;
alter function public.export_booth_selections(uuid) owner to vote_reader;
revoke create on schema public from vote_reader;
revoke all on function public.export_booth_selections(uuid) from public;
grant execute on function public.export_booth_selections(uuid) to app_server;

-- ---------------------------------------------------------------------------------------
-- The stored verification bundle (one per Election, append-only)
-- ---------------------------------------------------------------------------------------

create table public.verification_bundles (
  election_id uuid primary key references public.elections (id),
  -- The zip exactly as served, and its SHA-256 (also in the Result's Audit Event).
  zip bytea not null,
  bundle_hash text not null check (bundle_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint verification_bundles_hash_matches check (bundle_hash = encode(sha256(zip), 'hex'))
);

create trigger verification_bundles_no_update_delete
  before update or delete on public.verification_bundles
  for each row execute function public.forbid_append_only_mutation();
create trigger verification_bundles_no_truncate
  before truncate on public.verification_bundles
  for each statement execute function public.forbid_append_only_mutation();

revoke all on public.verification_bundles
  from public, anon, authenticated, service_role, app_migrator;
grant select, insert on public.verification_bundles to app_server;
alter table public.verification_bundles enable row level security;
create policy verification_bundles_app_server_select on public.verification_bundles
  for select to app_server using (true);
create policy verification_bundles_app_server_insert on public.verification_bundles
  for insert to app_server with check (true);
