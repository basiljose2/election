-- Ballot casting core: Ballot Sessions, Vote Selections, booth counters and signing keys.
--
-- Secrecy model (see openspec: ballot-casting-core):
--   * vote_selections holds the votes and NOTHING that links one to a session, terminal,
--     staff member, time, sequence or other vote. It has no timestamp or serial columns.
--   * app_server may only INSERT into vote_selections. It cannot SELECT, UPDATE, DELETE or
--     TRUNCATE them. Reading happens only through SECURITY DEFINER functions owned by the
--     `vote_reader` role, which check the Election/booth state themselves, so a bug in the
--     application cannot unseal counts.
--   * ballot_sessions records WHO/WHEN a ballot was issued and that it was cast, never what
--     was chosen; once Cast or Cancelled it can no longer change.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'vote_reader') then
    create role vote_reader nologin noinherit;
  end if;
end
$$;

-- Lets this migration set function ownership to vote_reader (no login, no inherit).
grant vote_reader to postgres with set true;
grant usage on schema public to vote_reader;

-- ---------------------------------------------------------------------------------------
-- Ballot Sessions
-- ---------------------------------------------------------------------------------------

create type public.ballot_session_status as enum ('pending', 'cast', 'cancelled');

create table public.ballot_sessions (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null,
  booth_id uuid not null,
  -- The Voting Terminal this session is bound to; no other device may fetch or cast it.
  terminal_id uuid not null,
  is_mock boolean not null,
  mock_round integer,
  status public.ballot_session_status not null default 'pending',
  -- SHA-256 of the single-use cast token and of the idempotency key (never the values).
  cast_token_hash text check (cast_token_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key_hash text check (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  issued_by uuid not null references public.staff (user_id),
  issued_at timestamptz not null default now(),
  finished_at timestamptz,
  cancel_reason text check (
    cancel_reason in ('voter_left', 'voter_refused', 'terminal_fault', 'booth_force_closed')
  ),
  cancel_note text check (length(cancel_note) <= 300),
  constraint ballot_sessions_booth_fk foreign key (booth_id, election_id)
    references public.booths (id, election_id),
  constraint ballot_sessions_terminal_fk foreign key (terminal_id, booth_id)
    references public.terminals (id, booth_id),
  constraint ballot_sessions_mock_round check (is_mock = (mock_round is not null)),
  constraint ballot_sessions_finished check ((status = 'pending') = (finished_at is null)),
  constraint ballot_sessions_cancel_reason check ((status = 'cancelled') = (cancel_reason is not null)),
  constraint ballot_sessions_cast_key check (status <> 'cast' or idempotency_key_hash is not null)
);

-- At most one pending Ballot Session per booth.
create unique index ballot_sessions_one_pending on public.ballot_sessions (booth_id)
  where status = 'pending';
create index ballot_sessions_booth_idx on public.ballot_sessions (booth_id, is_mock, mock_round, status);

create function public.ballot_sessions_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'pending' then
    raise exception 'a % Ballot Session cannot change', old.status using errcode = 'P0001';
  end if;
  if (new.id, new.election_id, new.booth_id, new.terminal_id, new.is_mock, new.mock_round,
      new.issued_by, new.issued_at)
     is distinct from
     (old.id, old.election_id, old.booth_id, old.terminal_id, old.is_mock, old.mock_round,
      old.issued_by, old.issued_at) then
    raise exception 'Ballot Session identity cannot change' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger ballot_sessions_guard_update
  before update on public.ballot_sessions
  for each row execute function public.ballot_sessions_guard_update();
create trigger ballot_sessions_no_delete
  before delete on public.ballot_sessions
  for each row execute function public.forbid_append_only_mutation();
create trigger ballot_sessions_no_truncate
  before truncate on public.ballot_sessions
  for each statement execute function public.forbid_append_only_mutation();

-- ---------------------------------------------------------------------------------------
-- Booth counters (turnout is public; per-candidate counts are not)
-- ---------------------------------------------------------------------------------------

create table public.booth_counters (
  booth_id uuid primary key references public.booths (id) on delete cascade,
  ballots_cast bigint not null default 0 check (ballots_cast >= 0),
  ballots_cancelled bigint not null default 0 check (ballots_cancelled >= 0),
  -- Incremented each time the booth enters Mock Poll; mock Vote Selections carry it.
  mock_round integer not null default 0 check (mock_round >= 0)
);

create function public.booths_create_counters()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.booth_counters (booth_id) values (new.id);
  return new;
end;
$$;

create trigger booths_create_counters
  after insert on public.booths
  for each row execute function public.booths_create_counters();

insert into public.booth_counters (booth_id) select id from public.booths;

-- Counters only ever go up.
create function public.booth_counters_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.booth_id <> old.booth_id
     or new.ballots_cast < old.ballots_cast
     or new.ballots_cancelled < old.ballots_cancelled
     or new.mock_round < old.mock_round then
    raise exception 'booth counters can only increase' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger booth_counters_guard_update
  before update on public.booth_counters
  for each row execute function public.booth_counters_guard_update();

-- ---------------------------------------------------------------------------------------
-- Vote Selections
-- ---------------------------------------------------------------------------------------

create table public.vote_selections (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null,
  booth_id uuid not null,
  post_id uuid not null,
  -- Exactly one of a Candidate or NOTA.
  candidate_id uuid references public.candidates (id),
  is_nota boolean not null default false,
  is_mock boolean not null default false,
  mock_round integer,
  -- Ed25519 over the canonical content, base64url (64 bytes = 86 characters).
  signature text not null check (signature ~ '^[A-Za-z0-9_-]{86}$'),
  constraint vote_selections_choice check ((candidate_id is null) = is_nota),
  constraint vote_selections_mock check (is_mock = (mock_round is not null)),
  constraint vote_selections_booth_fk foreign key (booth_id, election_id)
    references public.booths (id, election_id),
  constraint vote_selections_post_fk foreign key (post_id, election_id)
    references public.posts (id, election_id)
);

comment on table public.vote_selections is
  'Votes. No timestamp, sequence or session reference by design. app_server: INSERT only.';

create trigger vote_selections_no_update_delete
  before update or delete on public.vote_selections
  for each row execute function public.forbid_append_only_mutation();
create trigger vote_selections_no_truncate
  before truncate on public.vote_selections
  for each statement execute function public.forbid_append_only_mutation();

-- ---------------------------------------------------------------------------------------
-- Election signing keys (one Ed25519 key pair per Election, created at first freeze)
-- ---------------------------------------------------------------------------------------

create table public.election_signing_keys (
  election_id uuid primary key references public.elections (id),
  -- Raw 32-byte Ed25519 public key, base64url; published with the Setup Hash.
  public_key text not null check (public_key ~ '^[A-Za-z0-9_-]{43}$'),
  -- AES-256-GCM envelope (wrapped data key + ciphertext of the private key). The master key
  -- that unwraps it lives only in a server environment variable.
  private_key_envelope jsonb not null check (jsonb_typeof(private_key_envelope) = 'object'),
  created_at timestamptz not null default now()
);

create trigger election_signing_keys_no_update_delete
  before update or delete on public.election_signing_keys
  for each row execute function public.forbid_append_only_mutation();
create trigger election_signing_keys_no_truncate
  before truncate on public.election_signing_keys
  for each statement execute function public.forbid_append_only_mutation();

-- ---------------------------------------------------------------------------------------
-- Sealed readers (SECURITY DEFINER, owned by vote_reader)
-- ---------------------------------------------------------------------------------------

grant select on public.vote_selections to vote_reader;
grant select on public.booth_states, public.booth_counters, public.elections to vote_reader;

create policy vote_selections_vote_reader_select on public.vote_selections
  for select to vote_reader using (true);
-- The reader functions check Election/booth state themselves, so the role must see it.
create policy elections_vote_reader_select on public.elections
  for select to vote_reader using (true);
create policy booth_states_vote_reader_select on public.booth_states
  for select to vote_reader using (true);
create policy booth_counters_vote_reader_select on public.booth_counters
  for select to vote_reader using (true);

-- Mock counts for the booth's CURRENT mock round. Only mock rows are ever returned.
create function public.mock_counts(p_booth_id uuid, p_round integer)
returns table (post_id uuid, candidate_id uuid, is_nota boolean, votes bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select v.post_id, v.candidate_id, v.is_nota, count(*)::bigint
    from public.vote_selections v
    join public.booth_counters c on c.booth_id = v.booth_id
   where v.booth_id = p_booth_id
     and v.is_mock = true
     and v.mock_round = p_round
     and c.mock_round = p_round
   group by v.post_id, v.candidate_id, v.is_nota;
$$;

-- Row count and an order-independent digest of a CLOSED booth's real Vote Selections. No
-- per-candidate counts: those stay sealed until polling is completed.
create function public.booth_integrity_digest(p_booth_id uuid)
returns table (ballot_rows bigint, digest text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_state text;
begin
  select s.state::text into v_state from public.booth_states s where s.booth_id = p_booth_id;
  if v_state is null or v_state not in ('closed', 'sealed') then
    raise exception 'the integrity digest is available only after the booth is closed'
      using errcode = '42501';
  end if;
  return query
    select count(*)::bigint,
           encode(
             sha256(convert_to(
               coalesce(string_agg(
                 v.id::text || ':' || v.post_id::text || ':' ||
                 coalesce(v.candidate_id::text, 'NOTA') || ':' || v.signature,
                 ',' order by v.id), ''),
               'UTF8')),
             'hex')
      from public.vote_selections v
     where v.booth_id = p_booth_id and v.is_mock = false;
end;
$$;

-- Per-candidate real counts for an Election. Raises until polling is completed.
create function public.election_tally(p_election_id uuid)
returns table (post_id uuid, candidate_id uuid, is_nota boolean, votes bigint)
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
    select v.post_id, v.candidate_id, v.is_nota, count(*)::bigint
      from public.vote_selections v
     where v.election_id = p_election_id and v.is_mock = false
     group by v.post_id, v.candidate_id, v.is_nota;
end;
$$;

-- A new owner needs CREATE on the schema while ownership is transferred.
grant create on schema public to vote_reader;
alter function public.mock_counts(uuid, integer) owner to vote_reader;
alter function public.booth_integrity_digest(uuid) owner to vote_reader;
alter function public.election_tally(uuid) owner to vote_reader;
revoke create on schema public from vote_reader;

-- ---------------------------------------------------------------------------------------
-- Force close: cancel pending sessions and count them
-- ---------------------------------------------------------------------------------------

create or replace function public.cancel_pending_ballot_sessions(p_booth_id uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  with cancelled as (
    update public.ballot_sessions
       set status = 'cancelled', finished_at = now(), cancel_reason = 'booth_force_closed'
     where booth_id = p_booth_id and status = 'pending'
    returning 1
  )
  select count(*)::integer into v_count from cancelled;
  if v_count > 0 then
    update public.booth_counters set ballots_cancelled = ballots_cancelled + v_count
     where booth_id = p_booth_id;
  end if;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Privileges and row level security
-- ---------------------------------------------------------------------------------------

revoke all on function public.ballot_sessions_guard_update() from public;
revoke all on function public.booths_create_counters() from public;
revoke all on function public.booth_counters_guard_update() from public;
revoke all on function public.mock_counts(uuid, integer) from public;
revoke all on function public.booth_integrity_digest(uuid) from public;
revoke all on function public.election_tally(uuid) from public;
grant execute on function public.mock_counts(uuid, integer) to app_server;
grant execute on function public.booth_integrity_digest(uuid) to app_server;
grant execute on function public.election_tally(uuid) to app_server;

revoke all on public.ballot_sessions, public.booth_counters, public.vote_selections,
  public.election_signing_keys
  from public, anon, authenticated, service_role, app_migrator;

grant select, insert on public.ballot_sessions to app_server;
grant update (status, cast_token_hash, idempotency_key_hash, finished_at, cancel_reason, cancel_note)
  on public.ballot_sessions to app_server;

grant select on public.booth_counters to app_server;
grant update (ballots_cast, ballots_cancelled, mock_round) on public.booth_counters to app_server;

-- INSERT only: no SELECT, UPDATE, DELETE or TRUNCATE on the votes for the application role.
grant insert on public.vote_selections to app_server;

grant select, insert on public.election_signing_keys to app_server;

alter table public.ballot_sessions enable row level security;
alter table public.booth_counters enable row level security;
alter table public.vote_selections enable row level security;
alter table public.election_signing_keys enable row level security;

create policy ballot_sessions_app_server_select on public.ballot_sessions
  for select to app_server using (true);
create policy ballot_sessions_app_server_insert on public.ballot_sessions
  for insert to app_server with check (true);
create policy ballot_sessions_app_server_update on public.ballot_sessions
  for update to app_server using (true) with check (true);

create policy booth_counters_app_server_select on public.booth_counters
  for select to app_server using (true);
create policy booth_counters_app_server_update on public.booth_counters
  for update to app_server using (true) with check (true);

-- No SELECT policy for app_server on vote_selections: even a mistaken GRANT would show nothing.
create policy vote_selections_app_server_insert on public.vote_selections
  for insert to app_server with check (true);

create policy election_signing_keys_app_server_select on public.election_signing_keys
  for select to app_server using (true);
create policy election_signing_keys_app_server_insert on public.election_signing_keys
  for insert to app_server with check (true);
