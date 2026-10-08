-- Staff identities, role assignments and server-tracked sessions.
--
-- election_id / booth_id have no foreign keys yet: the elections and polling_booths
-- tables are created by the `election-setup` change, which adds the FKs.

create table public.staff (
  user_id uuid primary key references auth.users (id) on delete restrict,
  email text not null check (email = lower(email) and length(email) between 3 and 320),
  display_name text not null check (length(btrim(display_name)) between 1 and 200),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  deactivated_at timestamptz,
  constraint staff_deactivation_consistent check (active = (deactivated_at is null))
);

create unique index staff_email_key on public.staff (email);

create type public.staff_role as enum (
  'super_admin',
  'returning_officer',
  'presiding_officer',
  'observer'
);

create table public.staff_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.staff (user_id),
  role public.staff_role not null,
  election_id uuid,
  booth_id uuid,
  assigned_at timestamptz not null default now(),
  assigned_by uuid references public.staff (user_id),
  revoked_at timestamptz,
  revoked_by uuid references public.staff (user_id),
  -- Scope rules: RO and Observer -> exactly one Election; PO -> exactly one Polling Booth
  -- (election_id is the booth's Election, kept for scoping and audit chains);
  -- Super Admin -> global.
  constraint staff_roles_scope check (
    coalesce(
      case role
        when 'super_admin' then election_id is null and booth_id is null
        when 'returning_officer' then election_id is not null and booth_id is null
        when 'observer' then election_id is not null and booth_id is null
        when 'presiding_officer' then election_id is not null and booth_id is not null
      end,
      false
    )
  ),
  constraint staff_roles_revocation_consistent check ((revoked_at is null) = (revoked_by is null))
);

create unique index staff_roles_active_key on public.staff_roles (
  user_id,
  role,
  coalesce(election_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(booth_id, '00000000-0000-0000-0000-000000000000'::uuid)
) where revoked_at is null;

create index staff_roles_user_idx on public.staff_roles (user_id) where revoked_at is null;

-- A role assignment may only change by being revoked, once.
create function public.staff_roles_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.revoked_at is not null
     or new.revoked_at is null
     or (new.id, new.user_id, new.role, new.election_id, new.booth_id, new.assigned_at, new.assigned_by)
        is distinct from
        (old.id, old.user_id, old.role, old.election_id, old.booth_id, old.assigned_at, old.assigned_by)
  then
    raise exception 'staff_roles rows can only be revoked, once' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.staff_roles_guard_update() from public;

create trigger staff_roles_guard_update
  before update on public.staff_roles
  for each row execute function public.staff_roles_guard_update();

create trigger staff_roles_no_delete
  before delete on public.staff_roles
  for each row execute function public.forbid_append_only_mutation();

create trigger staff_roles_no_truncate
  before truncate on public.staff_roles
  for each statement execute function public.forbid_append_only_mutation();

-- Server-side session tracking (idle timeout, deactivation, sign-out). session_id is the
-- Supabase Auth session id from the access token.
create table public.staff_sessions (
  session_id uuid primary key,
  user_id uuid not null references public.staff (user_id),
  kind text not null default 'staff' check (kind in ('staff', 'master_terminal')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null,
  ended_at timestamptz,
  end_reason text check (end_reason in ('signed_out', 'idle_timeout', 'deactivated')),
  constraint staff_sessions_end_consistent check ((ended_at is null) = (end_reason is null))
);

create index staff_sessions_user_idx on public.staff_sessions (user_id) where ended_at is null;

-- Privileges
revoke all on public.staff, public.staff_roles, public.staff_sessions
  from public, anon, authenticated, service_role;

grant select, insert on public.staff to app_server;
grant update (active, deactivated_at, display_name) on public.staff to app_server;

grant select, insert on public.staff_roles to app_server;
grant update (revoked_at, revoked_by) on public.staff_roles to app_server;

grant select, insert on public.staff_sessions to app_server;
grant update (last_seen_at, ended_at, end_reason, kind) on public.staff_sessions to app_server;

-- Row level security: deny by default, app_server only.
alter table public.staff enable row level security;
alter table public.staff_roles enable row level security;
alter table public.staff_sessions enable row level security;

create policy staff_app_server on public.staff
  for all to app_server using (true) with check (true);
create policy staff_roles_app_server on public.staff_roles
  for all to app_server using (true) with check (true);
create policy staff_sessions_app_server on public.staff_sessions
  for all to app_server using (true) with check (true);
