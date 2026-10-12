-- Erasing all election data, for test and rehearsal databases ONLY.
--
-- Everything about an election is append-only on purpose (votes, tallies, results, the audit
-- chain), so erasing is a separate, deliberately awkward path with two independent locks:
--
--   1. A database-level switch, public.deployment_settings.allow_data_erase, that is false by
--      default and that the application role CANNOT change (it has SELECT only). Turning it on
--      takes the database owner (the Supabase SQL editor or `supabase db query`), so a
--      production database is protected even from a compromised application or Super Admin.
--   2. The function below refuses unless the switch is on, and only the application role may
--      call it; the application additionally requires a Super Admin, fresh re-authentication
--      and a typed confirmation (see src/lib/commands/system.ts).
--
-- Kept: staff accounts, Super Admin role assignments, sign-in throttling, and the reference
-- tables of permitted transitions (election_transitions, booth_transitions).
-- Erased: elections and everything under them, role assignments scoped to an election or
-- booth, and the audit log (the erase itself becomes the first event of the new chain).

create table public.deployment_settings (
  -- A single row.
  id boolean primary key default true check (id),
  allow_data_erase boolean not null default false,
  changed_at timestamptz not null default now()
);
insert into public.deployment_settings (id) values (true);

alter table public.deployment_settings enable row level security;
revoke all on public.deployment_settings from public, anon, authenticated, service_role, app_migrator;
grant select on public.deployment_settings to app_server;
create policy deployment_settings_app_server_select on public.deployment_settings
  for select to app_server using (true);

create function public.erase_all_election_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allowed boolean;
  v_counts jsonb;
  v_table text;
  v_tables text[] := array[
    'public.result_items', 'public.results', 'public.verification_bundles',
    'public.reconciliation_runs', 'public.booth_tallies', 'public.vote_selections',
    'public.ballot_sessions', 'public.terminal_heartbeats', 'public.pairing_codes',
    'public.pairing_attempts', 'public.terminals', 'public.booth_counters',
    'public.booth_state_versions', 'public.booth_states',
    'public.booth_posts', 'public.ballot_definitions', 'public.setup_snapshots',
    'public.election_signing_keys', 'public.candidates',
    'public.posts', 'public.booths', 'public.elections', 'public.audit_events'];
begin
  select s.allow_data_erase into v_allowed from public.deployment_settings s where s.id;
  if not coalesce(v_allowed, false) then
    raise exception 'erasing election data is not enabled for this database'
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'elections', (select count(*) from public.elections),
    'booths', (select count(*) from public.booths),
    'ballot_sessions', (select count(*) from public.ballot_sessions),
    'vote_selections', (select count(*) from public.vote_selections),
    'booth_tallies', (select count(*) from public.booth_tallies),
    'results', (select count(*) from public.results),
    'audit_events', (select count(*) from public.audit_events),
    'election_roles', (select count(*) from public.staff_roles
                        where election_id is not null or booth_id is not null))
    into v_counts;

  -- The append-only triggers are switched off for these tables for this transaction only
  -- (hosted Supabase does not let the owner use session_replication_role, but the owner may
  -- disable triggers on its own tables; a failure anywhere rolls all of it back).
  foreach v_table in array v_tables || array['public.staff_roles'] loop
    execute format('alter table %s disable trigger user', v_table);
  end loop;

  delete from public.staff_roles where election_id is not null or booth_id is not null;
  -- Row by row, children first (v_tables is in dependency order): staff_roles keeps its
  -- Super Admin rows and still references elections and booths, so TRUNCATE is not possible.
  foreach v_table in array v_tables loop
    execute format('delete from %s', v_table);
  end loop;

  foreach v_table in array v_tables || array['public.staff_roles'] loop
    execute format('alter table %s enable trigger user', v_table);
  end loop;
  return v_counts;
end;
$$;

revoke all on function public.erase_all_election_data() from public;
grant execute on function public.erase_all_election_data() to app_server;
