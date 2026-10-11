-- Results declaration: the booth-wise sealed reader and the immutable, signed Result.
--
-- * election_booth_tally(): per-booth, per-candidate real counts, sealed exactly like
--   election_tally() until polling is completed. Only the declaration reads it.
-- * results / result_items: append-only. One Result per Election (declare-once is enforced by
--   a unique key as well as by the lifecycle table), signed with the Election's key.

create function public.election_booth_tally(p_election_id uuid)
returns table (booth_id uuid, post_id uuid, candidate_id uuid, is_nota boolean, votes bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select e.status::text into v_status from public.elections e where e.id = p_election_id;
  if v_status is null or v_status not in ('polling_completed', 'results_declared', 'archived') then
    raise exception 'per-candidate counts are sealed until polling is completed'
      using errcode = '42501';
  end if;
  return query
    select v.booth_id, v.post_id, v.candidate_id, v.is_nota, count(*)::bigint
      from public.vote_selections v
     where v.election_id = p_election_id and v.is_mock = false
     group by v.booth_id, v.post_id, v.candidate_id, v.is_nota;
end;
$$;

grant create on schema public to vote_reader;
alter function public.election_booth_tally(uuid) owner to vote_reader;
revoke create on schema public from vote_reader;

revoke all on function public.election_booth_tally(uuid) from public;
grant execute on function public.election_booth_tally(uuid) to app_server;

-- ---------------------------------------------------------------------------------------

create table public.results (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references public.elections (id),
  -- The signed document exactly as signed (canonical JSON), its SHA-256 (the Result hash) and
  -- the Ed25519 signature (base64url) by the Election's key.
  canonical_json text not null,
  result_hash text not null check (result_hash ~ '^[0-9a-f]{64}$'),
  signature text not null check (signature ~ '^[A-Za-z0-9_-]{86}$'),
  declared_by uuid references public.staff (user_id),
  declared_at timestamptz not null default now(),
  constraint results_one_per_election unique (election_id),
  constraint results_hash_matches
    check (result_hash = encode(sha256(convert_to(canonical_json, 'UTF8')), 'hex'))
);

create table public.result_items (
  id uuid primary key default gen_random_uuid(),
  result_id uuid not null references public.results (id),
  post_id uuid not null,
  -- NULL candidate_id means NOTA.
  candidate_id uuid,
  is_nota boolean not null,
  -- NULL booth_id means the election-wide total for the Post.
  booth_id uuid,
  votes bigint not null check (votes >= 0),
  constraint result_items_choice check ((candidate_id is null) = is_nota)
);

create index result_items_result_idx on public.result_items (result_id, post_id);

create trigger results_no_update_delete
  before update or delete on public.results
  for each row execute function public.forbid_append_only_mutation();
create trigger results_no_truncate
  before truncate on public.results
  for each statement execute function public.forbid_append_only_mutation();
create trigger result_items_no_update_delete
  before update or delete on public.result_items
  for each row execute function public.forbid_append_only_mutation();
create trigger result_items_no_truncate
  before truncate on public.result_items
  for each statement execute function public.forbid_append_only_mutation();

revoke all on public.results, public.result_items
  from public, anon, authenticated, service_role, app_migrator;
grant select, insert on public.results to app_server;
grant select, insert on public.result_items to app_server;

alter table public.results enable row level security;
alter table public.result_items enable row level security;

create policy results_app_server_select on public.results
  for select to app_server using (true);
create policy results_app_server_insert on public.results
  for insert to app_server with check (true);
create policy result_items_app_server_select on public.result_items
  for select to app_server using (true);
create policy result_items_app_server_insert on public.result_items
  for insert to app_server with check (true);
