-- Terminals (Master and Voting), pairing codes, heartbeats and the per-booth state version.
--
-- * A terminal credential is a random token; only its SHA-256 is stored. Terminals are never
--   deleted; they are revoked once.
-- * At most one active terminal of each type per booth, enforced by a partial unique index.
-- * pairing_codes: at most one live code per booth; the code is stored hashed.
-- * terminal_heartbeats and pairing_attempts are small operational tables (not audited:
--   they are far too frequent); everything that changes who may act IS audited by commands.

create type public.terminal_type as enum ('master', 'voting');
create type public.terminal_status as enum ('active', 'revoked');

create table public.terminals (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null,
  booth_id uuid not null,
  type public.terminal_type not null,
  status public.terminal_status not null default 'active',
  credential_hash text not null check (credential_hash ~ '^[0-9a-f]{64}$'),
  -- Short device identifier shown to the Presiding Officer at pairing (voting terminals).
  device_id text check (device_id ~ '^[0-9A-Z]{4}$'),
  registered_by uuid references public.staff (user_id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_reason text check (length(revoked_reason) between 1 and 200),
  constraint terminals_booth_fk foreign key (booth_id, election_id)
    references public.booths (id, election_id),
  constraint terminals_id_booth_key unique (id, booth_id),
  constraint terminals_revocation_consistent check (
    (status = 'revoked') = (revoked_at is not null and revoked_reason is not null)
  )
);

create unique index terminals_credential_key on public.terminals (credential_hash);
create unique index terminals_one_active_per_type on public.terminals (booth_id, type)
  where status = 'active';
create index terminals_booth_idx on public.terminals (booth_id, type, created_at desc);

-- A terminal changes only by being revoked, once.
create function public.terminals_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'active'
     or new.status <> 'revoked'
     or (new.id, new.election_id, new.booth_id, new.type, new.credential_hash, new.device_id,
         new.registered_by, new.created_at)
        is distinct from
        (old.id, old.election_id, old.booth_id, old.type, old.credential_hash, old.device_id,
         old.registered_by, old.created_at)
  then
    raise exception 'terminals can only be revoked, once' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger terminals_guard_update
  before update on public.terminals
  for each row execute function public.terminals_guard_update();
create trigger terminals_no_delete
  before delete on public.terminals
  for each row execute function public.forbid_row_delete();
create trigger terminals_no_truncate
  before truncate on public.terminals
  for each statement execute function public.forbid_row_delete();

create type public.pairing_code_status as enum (
  'active',       -- shown on the Master Terminal, not yet used
  'pending',      -- a kiosk submitted it; waiting for the Presiding Officer
  'confirmed',    -- the Presiding Officer confirmed; credential not yet collected
  'completed',    -- the kiosk collected its credential
  'rejected',     -- the Presiding Officer rejected the device
  'expired',
  'invalidated'   -- too many wrong attempts, or superseded by a newer code
);

create table public.pairing_codes (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null,
  booth_id uuid not null,
  -- SHA-256 over (id || ':' || code); 6 digits are brute-forceable offline, so this only
  -- protects against casual reads. Online guessing is bounded by attempts and rate limits.
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  status public.pairing_code_status not null default 'active',
  expires_at timestamptz not null,
  attempts integer not null default 0 check (attempts between 0 and 5),
  -- Set when a kiosk submits the code.
  device_nonce_hash text check (device_nonce_hash ~ '^[0-9a-f]{64}$'),
  device_id text check (device_id ~ '^[0-9A-Z]{4}$'),
  pending_expires_at timestamptz,
  terminal_id uuid,
  created_by uuid not null references public.staff (user_id),
  created_at timestamptz not null default now(),
  constraint pairing_codes_booth_fk foreign key (booth_id, election_id)
    references public.booths (id, election_id),
  constraint pairing_codes_terminal_fk foreign key (terminal_id, booth_id)
    references public.terminals (id, booth_id)
);

-- One live code per booth. (Code generation also avoids reusing a value that another booth's
-- live code has, so a kiosk that types a code reaches exactly one booth.)
create unique index pairing_codes_one_live_per_booth on public.pairing_codes (booth_id)
  where status in ('active', 'pending', 'confirmed');

-- Pairing codes may only move forward: never reactivated, identity fields never change.
create function public.pairing_codes_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.id, new.election_id, new.booth_id, new.code_hash, new.expires_at, new.created_by,
      new.created_at)
     is distinct from
     (old.id, old.election_id, old.booth_id, old.code_hash, old.expires_at, old.created_by,
      old.created_at) then
    raise exception 'pairing code identity cannot change' using errcode = 'P0001';
  end if;
  if old.status in ('completed', 'rejected', 'expired', 'invalidated') then
    raise exception 'a finished pairing code cannot change' using errcode = 'P0001';
  end if;
  if new.status = 'active' and old.status <> 'active' then
    raise exception 'a pairing code cannot be reactivated' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger pairing_codes_guard_update
  before update on public.pairing_codes
  for each row execute function public.pairing_codes_guard_update();
create trigger pairing_codes_no_delete
  before delete on public.pairing_codes
  for each row execute function public.forbid_row_delete();

-- Wrong-code attempts per client network address (hashed), for rate limiting.
create table public.pairing_attempts (
  id bigint generated always as identity primary key,
  ip_hash text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  succeeded boolean not null,
  attempted_at timestamptz not null default now()
);
create index pairing_attempts_ip_idx on public.pairing_attempts (ip_hash, attempted_at desc);
create index pairing_attempts_time_idx on public.pairing_attempts (attempted_at desc);

create table public.terminal_heartbeats (
  terminal_id uuid primary key references public.terminals (id),
  last_seen_at timestamptz not null
);

-- Per-booth counter, incremented by every transaction that changes what a terminal shows.
-- Clients ignore signals older than the version they already hold.
create table public.booth_state_versions (
  booth_id uuid primary key references public.booths (id),
  version bigint not null default 0 check (version >= 0)
);

create function public.bump_booth_state_version(p_booth_id uuid)
returns bigint
language sql
set search_path = ''
as $$
  insert into public.booth_state_versions as v (booth_id, version)
  values (p_booth_id, 1)
  on conflict (booth_id) do update set version = v.version + 1
  returning v.version;
$$;

-- Where the booth is in its life, for pairing and credential checks. Elections are Draft or
-- Frozen today; election-state-machines adds polling states and a `booth_states` table
-- (booth_id, state), which this function reads when it exists. Fail closed: only these
-- phases accept terminals.
create function public.booth_accepts_terminals(p_booth_id uuid)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_status text;
  v_booth_state text;
begin
  select e.status::text into v_status
    from public.booths b join public.elections e on e.id = b.election_id
   where b.id = p_booth_id;
  if v_status is null or v_status not in ('frozen', 'polling_open') then
    return false;
  end if;
  if to_regclass('public.booth_states') is not null then
    execute 'select state::text from public.booth_states where booth_id = $1'
      into v_booth_state using p_booth_id;
    if v_booth_state in ('closed', 'sealed') then
      return false;
    end if;
  end if;
  return true;
end;
$$;

-- True while a Ballot Session is pending at the booth. ballot_sessions belongs to
-- ballot-casting-core (booth_id, status); until it exists nothing can be pending.
create function public.booth_has_pending_ballot_session(p_booth_id uuid)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_found boolean;
begin
  if to_regclass('public.ballot_sessions') is null then
    return false;
  end if;
  execute 'select exists (select 1 from public.ballot_sessions
                           where booth_id = $1 and status::text = ''pending'')'
    into v_found using p_booth_id;
  return v_found;
end;
$$;

revoke all on function public.terminals_guard_update() from public;
revoke all on function public.pairing_codes_guard_update() from public;
revoke all on function public.bump_booth_state_version(uuid) from public;
revoke all on function public.booth_accepts_terminals(uuid) from public;
revoke all on function public.booth_has_pending_ballot_session(uuid) from public;
grant execute on function public.bump_booth_state_version(uuid) to app_server;
grant execute on function public.booth_accepts_terminals(uuid) to app_server;
grant execute on function public.booth_has_pending_ballot_session(uuid) to app_server;

revoke all on public.terminals, public.pairing_codes, public.pairing_attempts,
  public.terminal_heartbeats, public.booth_state_versions
  from public, anon, authenticated, service_role, app_migrator;

grant select, insert on public.terminals to app_server;
grant update (status, revoked_at, revoked_reason) on public.terminals to app_server;

grant select, insert on public.pairing_codes to app_server;
grant update (status, attempts, device_nonce_hash, device_id, pending_expires_at, terminal_id)
  on public.pairing_codes to app_server;

grant select, insert on public.pairing_attempts to app_server;

grant select, insert on public.terminal_heartbeats to app_server;
grant update (last_seen_at) on public.terminal_heartbeats to app_server;

grant select, insert on public.booth_state_versions to app_server;
grant update (version) on public.booth_state_versions to app_server;

alter table public.terminals enable row level security;
alter table public.pairing_codes enable row level security;
alter table public.pairing_attempts enable row level security;
alter table public.terminal_heartbeats enable row level security;
alter table public.booth_state_versions enable row level security;

create policy terminals_app_server on public.terminals
  for all to app_server using (true) with check (true);
create policy pairing_codes_app_server on public.pairing_codes
  for all to app_server using (true) with check (true);
create policy pairing_attempts_app_server on public.pairing_attempts
  for all to app_server using (true) with check (true);
create policy terminal_heartbeats_app_server on public.terminal_heartbeats
  for all to app_server using (true) with check (true);
create policy booth_state_versions_app_server on public.booth_state_versions
  for all to app_server using (true) with check (true);
