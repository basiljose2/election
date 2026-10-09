-- Election setup: Elections, Posts, Candidates, Polling Booths and the Booth-Post mapping,
-- plus the immutable per-booth Ballot Definitions and Setup Hash produced at freeze.
--
-- * Setup tables are editable only while the Election is Draft; triggers enforce this in
--   the database on top of the command checks (defence in depth).
-- * ballot_definitions and setup_snapshots are append-only, like audit_events. A later
--   freeze (after an unfreeze) appends a new generation (freeze_no); nothing is rewritten.
-- * This change also adds the foreign keys that staff_roles left open in the foundation
--   migration (election_id / booth_id), so a role can only point at a real Election/Booth.

create type public.election_status as enum ('draft', 'frozen');

create table public.elections (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 200),
  description text not null default '' check (length(description) <= 2000),
  polling_date date not null,
  nota_enabled boolean not null default false,
  status public.election_status not null default 'draft',
  -- Number of times this setup has been frozen; identifies the current snapshot generation.
  freeze_count integer not null default 0 check (freeze_count >= 0),
  frozen_at timestamptz,
  cloned_from uuid references public.elections (id),
  created_by uuid references public.staff (user_id),
  created_at timestamptz not null default now(),
  constraint elections_frozen_consistent check ((status = 'frozen') = (frozen_at is not null))
);

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references public.elections (id),
  name text not null check (length(btrim(name)) between 1 and 200),
  display_order integer not null check (display_order >= 0),
  seats integer not null check (seats >= 1),
  -- Set at freeze: candidates = seats, so the Post is not on any ballot.
  uncontested boolean not null default false,
  created_at timestamptz not null default now(),
  constraint posts_id_election_key unique (id, election_id)
);

create unique index posts_name_key on public.posts (election_id, lower(btrim(name)));
create index posts_order_idx on public.posts (election_id, display_order, id);

create table public.candidates (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null,
  post_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 200),
  sort_order integer not null check (sort_order >= 0),
  -- Content hashes (SHA-256 hex) of the re-encoded WebP files in the media bucket.
  photo_hash text check (photo_hash ~ '^[0-9a-f]{64}$'),
  symbol_hash text check (symbol_hash ~ '^[0-9a-f]{64}$'),
  symbol_text text check (length(btrim(symbol_text)) between 1 and 40),
  created_at timestamptz not null default now(),
  constraint candidates_post_fk foreign key (post_id, election_id)
    references public.posts (id, election_id),
  constraint candidates_symbol_one_kind check (symbol_hash is null or symbol_text is null)
);

create unique index candidates_name_key on public.candidates (post_id, lower(btrim(name)));
create index candidates_order_idx on public.candidates (post_id, sort_order, id);

create table public.booths (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references public.elections (id),
  name text not null check (length(btrim(name)) between 1 and 200),
  location text not null check (length(btrim(location)) between 1 and 300),
  created_at timestamptz not null default now(),
  constraint booths_id_election_key unique (id, election_id)
);

create unique index booths_name_key on public.booths (election_id, lower(btrim(name)));

create table public.booth_posts (
  election_id uuid not null,
  booth_id uuid not null,
  post_id uuid not null,
  primary key (booth_id, post_id),
  constraint booth_posts_booth_fk foreign key (booth_id, election_id)
    references public.booths (id, election_id),
  constraint booth_posts_post_fk foreign key (post_id, election_id)
    references public.posts (id, election_id)
);

create index booth_posts_post_idx on public.booth_posts (post_id);

-- Roles can only point at a real Election, and a Presiding Officer at a booth of that Election.
alter table public.staff_roles
  add constraint staff_roles_election_fk foreign key (election_id) references public.elections (id),
  add constraint staff_roles_booth_fk foreign key (booth_id, election_id)
    references public.booths (id, election_id);

-- Exactly one Presiding Officer per Polling Booth.
create unique index staff_roles_one_po_per_booth on public.staff_roles (booth_id)
  where role = 'presiding_officer' and revoked_at is null;

-- ---------------------------------------------------------------------------------------
-- Draft-only editing
-- ---------------------------------------------------------------------------------------

-- Shared by posts, candidates, booths and booth_posts (all carry election_id). The share lock
-- on the Election row serialises edits against a concurrent freeze, which takes it FOR UPDATE.
create function public.setup_require_draft()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_election uuid;
  v_status public.election_status;
begin
  for v_election in
    select distinct e from (
      select case when tg_op = 'INSERT' then null else old.election_id end as e
      union all
      select case when tg_op = 'DELETE' then null else new.election_id end
    ) ids where e is not null
  loop
    select status into v_status from public.elections where id = v_election for share;
    if v_status is distinct from 'draft' then
      raise exception '% on %.% is not allowed: the Election is not in Draft',
        tg_op, tg_table_schema, tg_table_name
        using errcode = 'P0001';
    end if;
  end loop;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger posts_draft_only
  before insert or update or delete on public.posts
  for each row execute function public.setup_require_draft();
create trigger candidates_draft_only
  before insert or update or delete on public.candidates
  for each row execute function public.setup_require_draft();
create trigger booths_draft_only
  before insert or update or delete on public.booths
  for each row execute function public.setup_require_draft();
create trigger booth_posts_draft_only
  before insert or update or delete on public.booth_posts
  for each row execute function public.setup_require_draft();

-- True once any Ballot Session (mock or real) was issued at a booth of the Election.
-- ballot_sessions belongs to the ballot-casting-core change, so it is looked up dynamically;
-- until it exists there can be no session. If the table exists but cannot be read, the error
-- propagates and the unfreeze fails closed.
create function public.election_has_ballot_session(p_election_id uuid)
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
  execute 'select exists (select 1 from public.ballot_sessions s
                           join public.booths b on b.id = s.booth_id
                          where b.election_id = $1)'
    into v_found
    using p_election_id;
  return v_found;
end;
$$;

-- Guards Election updates: content is editable only in Draft; the only status changes are
-- draft -> frozen (freeze_count + 1) and frozen -> draft (never once a Ballot Session exists).
create function public.elections_guard_update()
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

create trigger elections_guard_update
  before update on public.elections
  for each row execute function public.elections_guard_update();

create function public.forbid_row_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'DELETE on %.% is not allowed', tg_table_schema, tg_table_name
    using errcode = 'P0001';
end;
$$;

create trigger elections_no_delete
  before delete on public.elections
  for each row execute function public.forbid_row_delete();
create trigger elections_no_truncate
  before truncate on public.elections
  for each statement execute function public.forbid_row_delete();

-- ---------------------------------------------------------------------------------------
-- Frozen snapshots (append-only)
-- ---------------------------------------------------------------------------------------

create table public.setup_snapshots (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references public.elections (id),
  freeze_no integer not null check (freeze_no >= 1),
  -- Exact canonical JSON text that was hashed (docs/SETUP_FORMAT.md). Kept as text so the
  -- bytes a verifier hashes are the bytes we hashed.
  canonical_json text not null,
  setup_hash text not null check (setup_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint setup_snapshots_generation_key unique (election_id, freeze_no),
  constraint setup_snapshots_hash_matches
    check (setup_hash = encode(sha256(convert_to(canonical_json, 'UTF8')), 'hex'))
);

create table public.ballot_definitions (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null,
  freeze_no integer not null,
  booth_id uuid not null,
  canonical_json text not null,
  definition_hash text not null check (definition_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint ballot_definitions_booth_key unique (election_id, freeze_no, booth_id),
  constraint ballot_definitions_snapshot_fk foreign key (election_id, freeze_no)
    references public.setup_snapshots (election_id, freeze_no),
  constraint ballot_definitions_booth_fk foreign key (booth_id, election_id)
    references public.booths (id, election_id),
  constraint ballot_definitions_hash_matches
    check (definition_hash = encode(sha256(convert_to(canonical_json, 'UTF8')), 'hex'))
);

create trigger setup_snapshots_no_update_delete
  before update or delete on public.setup_snapshots
  for each row execute function public.forbid_append_only_mutation();
create trigger setup_snapshots_no_truncate
  before truncate on public.setup_snapshots
  for each statement execute function public.forbid_append_only_mutation();
create trigger ballot_definitions_no_update_delete
  before update or delete on public.ballot_definitions
  for each row execute function public.forbid_append_only_mutation();
create trigger ballot_definitions_no_truncate
  before truncate on public.ballot_definitions
  for each statement execute function public.forbid_append_only_mutation();

-- ---------------------------------------------------------------------------------------
-- Privileges and row level security (app_server only)
-- ---------------------------------------------------------------------------------------

revoke all on function public.setup_require_draft() from public;
revoke all on function public.election_has_ballot_session(uuid) from public;
revoke all on function public.elections_guard_update() from public;
revoke all on function public.forbid_row_delete() from public;
grant execute on function public.election_has_ballot_session(uuid) to app_server;

revoke all on public.elections, public.posts, public.candidates, public.booths,
  public.booth_posts, public.setup_snapshots, public.ballot_definitions
  from public, anon, authenticated, service_role, app_migrator;

grant select, insert on public.elections to app_server;
grant update (name, description, polling_date, nota_enabled, status, freeze_count, frozen_at)
  on public.elections to app_server;

grant select, insert, delete on public.posts to app_server;
grant update (name, display_order, seats, uncontested) on public.posts to app_server;

grant select, insert, delete on public.candidates to app_server;
grant update (name, sort_order, photo_hash, symbol_hash, symbol_text)
  on public.candidates to app_server;

grant select, insert, delete on public.booths to app_server;
grant update (name, location) on public.booths to app_server;

grant select, insert, delete on public.booth_posts to app_server;

grant select, insert on public.setup_snapshots to app_server;
grant select, insert on public.ballot_definitions to app_server;

alter table public.elections enable row level security;
alter table public.posts enable row level security;
alter table public.candidates enable row level security;
alter table public.booths enable row level security;
alter table public.booth_posts enable row level security;
alter table public.setup_snapshots enable row level security;
alter table public.ballot_definitions enable row level security;

create policy elections_app_server on public.elections
  for all to app_server using (true) with check (true);
create policy posts_app_server on public.posts
  for all to app_server using (true) with check (true);
create policy candidates_app_server on public.candidates
  for all to app_server using (true) with check (true);
create policy booths_app_server on public.booths
  for all to app_server using (true) with check (true);
create policy booth_posts_app_server on public.booth_posts
  for all to app_server using (true) with check (true);
create policy setup_snapshots_app_server_select on public.setup_snapshots
  for select to app_server using (true);
create policy setup_snapshots_app_server_insert on public.setup_snapshots
  for insert to app_server with check (true);
create policy ballot_definitions_app_server_select on public.ballot_definitions
  for select to app_server using (true);
create policy ballot_definitions_app_server_insert on public.ballot_definitions
  for insert to app_server with check (true);
