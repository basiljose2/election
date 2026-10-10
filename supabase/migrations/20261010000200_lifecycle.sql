-- Election and Polling Booth lifecycles (election-state-machines).
--
-- The TypeScript transition tables (src/lib/lifecycle/tables.ts) are the source of truth for
-- who may do what and under which guards. This file holds the SQL copy of the permitted
-- (from, to) pairs, enforced by triggers as defence in depth; a CI test
-- (tests/integration/lifecycle-tables.test.ts) fails if the two copies differ.

-- ---------------------------------------------------------------------------------------
-- Permitted transitions (SQL copy)
-- ---------------------------------------------------------------------------------------

create table public.election_transitions (
  from_status public.election_status not null,
  to_status public.election_status not null,
  primary key (from_status, to_status)
);

insert into public.election_transitions (from_status, to_status) values
  ('draft', 'frozen'),
  ('frozen', 'draft'),
  ('frozen', 'polling_open'),
  ('polling_open', 'polling_completed'),
  ('polling_completed', 'results_declared'),
  ('results_declared', 'archived');

create type public.booth_state as enum ('setup', 'mock_poll', 'mock_cleared', 'open', 'closed', 'sealed');

create table public.booth_transitions (
  from_state public.booth_state not null,
  to_state public.booth_state not null,
  primary key (from_state, to_state)
);

insert into public.booth_transitions (from_state, to_state) values
  ('setup', 'mock_poll'),
  ('mock_poll', 'mock_cleared'),
  ('mock_cleared', 'mock_poll'),
  ('mock_cleared', 'open'),
  ('open', 'closed'),
  ('closed', 'sealed');

-- ---------------------------------------------------------------------------------------
-- Election status: any change must be a permitted transition
-- ---------------------------------------------------------------------------------------

-- frozen_at now marks "has been frozen at least once in this cycle": set for every state
-- after Draft, cleared only by unfreezing.
alter table public.elections drop constraint elections_frozen_consistent;
alter table public.elections add constraint elections_frozen_consistent
  check ((status = 'draft') = (frozen_at is null));

create or replace function public.elections_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.id, new.created_at, new.created_by, new.cloned_from)
     is distinct from (old.id, old.created_at, old.created_by, old.cloned_from) then
    raise exception 'elections identity columns cannot change' using errcode = 'P0001';
  end if;

  if (old.status <> 'draft' or new.status <> 'draft')
     and (new.name, new.description, new.polling_date, new.nota_enabled)
         is distinct from (old.name, old.description, old.polling_date, old.nota_enabled) then
    raise exception 'an Election can be edited only while it is in Draft' using errcode = 'P0001';
  end if;

  if new.status <> old.status then
    if not exists (
      select 1 from public.election_transitions t
       where t.from_status = old.status and t.to_status = new.status
    ) then
      raise exception 'illegal Election transition % -> %', old.status, new.status
        using errcode = 'P0001';
    end if;
  end if;

  if old.status = 'draft' and new.status = 'frozen' then
    if new.freeze_count <> old.freeze_count + 1 then
      raise exception 'freeze must advance freeze_count by one' using errcode = 'P0001';
    end if;
  elsif old.status = 'frozen' and new.status = 'draft' then
    if new.freeze_count <> old.freeze_count then
      raise exception 'unfreeze must not change freeze_count' using errcode = 'P0001';
    end if;
    if public.election_has_ballot_session(old.id) then
      raise exception 'cannot unfreeze: a Ballot Session has been issued in this Election'
        using errcode = 'P0001';
    end if;
  elsif new.freeze_count <> old.freeze_count then
    raise exception 'freeze_count changes only when freezing' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Booth states
-- ---------------------------------------------------------------------------------------

create table public.booth_states (
  booth_id uuid primary key references public.booths (id) on delete cascade,
  state public.booth_state not null default 'setup',
  updated_at timestamptz not null default now()
);

-- Every booth starts in Setup; rows are created by the database, never by application code.
create function public.booths_create_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.booth_states (booth_id) values (new.id);
  return new;
end;
$$;

create trigger booths_create_state
  after insert on public.booths
  for each row execute function public.booths_create_state();

insert into public.booth_states (booth_id) select id from public.booths;

create function public.booth_states_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.booth_id <> old.booth_id then
    raise exception 'booth_states.booth_id cannot change' using errcode = 'P0001';
  end if;
  if new.state <> old.state then
    if not exists (
      select 1 from public.booth_transitions t
       where t.from_state = old.state and t.to_state = new.state
    ) then
      raise exception 'illegal booth transition % -> %', old.state, new.state
        using errcode = 'P0001';
    end if;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create trigger booth_states_guard_update
  before update on public.booth_states
  for each row execute function public.booth_states_guard_update();

-- A booth that has left Setup keeps its history: its state row may not be deleted directly.
-- (Cascade from deleting a Draft booth is allowed: that happens only in Draft.)

-- Cancels Ballot Sessions still pending at a booth (used by the Returning Officer's force
-- close). ballot_sessions belongs to ballot-casting-core (booth_id, status); until it exists
-- there is nothing to cancel. Returns how many sessions were cancelled.
create function public.cancel_pending_ballot_sessions(p_booth_id uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  if to_regclass('public.ballot_sessions') is null then
    return 0;
  end if;
  execute 'with c as (update public.ballot_sessions set status = ''cancelled''
                       where booth_id = $1 and status::text = ''pending'' returning 1)
           select count(*)::integer from c'
    into v_count using p_booth_id;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Privileges and row level security
-- ---------------------------------------------------------------------------------------

revoke all on function public.booths_create_state() from public;
revoke all on function public.booth_states_guard_update() from public;
revoke all on function public.cancel_pending_ballot_sessions(uuid) from public;
grant execute on function public.cancel_pending_ballot_sessions(uuid) to app_server;

revoke all on public.election_transitions, public.booth_transitions, public.booth_states
  from public, anon, authenticated, service_role, app_migrator;

grant select on public.election_transitions to app_server;
grant select on public.booth_transitions to app_server;
grant select on public.booth_states to app_server;
grant update (state) on public.booth_states to app_server;

alter table public.election_transitions enable row level security;
alter table public.booth_transitions enable row level security;
alter table public.booth_states enable row level security;

create policy election_transitions_app_server_select on public.election_transitions
  for select to app_server using (true);
create policy booth_transitions_app_server_select on public.booth_transitions
  for select to app_server using (true);
create policy booth_states_app_server_select on public.booth_states
  for select to app_server using (true);
create policy booth_states_app_server_update on public.booth_states
  for update to app_server using (true) with check (true);
