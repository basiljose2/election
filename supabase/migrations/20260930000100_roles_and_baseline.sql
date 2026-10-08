-- Baseline security for the Campus EVM database.
--
-- * app_server   : the only role server code connects as. Gets explicit, minimal grants
--                  per table (append-only tables: INSERT/SELECT only).
-- * app_migrator : used by CI to apply migrations. LOGIN is enabled per environment
--                  out of band; it never runs application code.
-- * anon / authenticated / service_role (Supabase built-ins): no privileges on
--   application tables. Browsers never write to the database.
--
-- Every table in `public` MUST have row level security enabled with no policy for
-- anon/authenticated (deny by default). supabase/tests/00_baseline_security.test.sql
-- enforces this for every table, including tables added by later changes.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'app_server') then
    create role app_server nologin noinherit;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'app_migrator') then
    create role app_migrator nologin noinherit;
  end if;
end
$$;

-- Lets the owner role manage app_migrator's default privileges below.
grant app_migrator to postgres;

grant usage on schema public to app_server;
grant usage, create on schema public to app_migrator;

-- Supabase grants everything on new objects in `public` to the API roles by default.
-- Revoke those defaults so a new table is private until a migration grants access.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, service_role, public;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, service_role, public;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated, service_role, public;

alter default privileges for role app_migrator in schema public
  revoke all on tables from anon, authenticated, service_role, public;
alter default privileges for role app_migrator in schema public
  revoke all on sequences from anon, authenticated, service_role, public;
alter default privileges for role app_migrator in schema public
  revoke all on functions from anon, authenticated, service_role, public;

-- Nothing exists yet, but keep the revoke explicit in case this runs on a used database.
revoke all on all tables in schema public from anon, authenticated, service_role;
revoke all on all sequences in schema public from anon, authenticated, service_role;
revoke all on all functions in schema public from anon, authenticated, service_role, public;

-- Shared trigger function for append-only tables (audit_events here; vote tables later).
create function public.forbid_append_only_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% on %.% is not allowed: the table is append-only',
    tg_op, tg_table_schema, tg_table_name
    using errcode = 'P0001';
end;
$$;

-- Schema-level default privileges cannot remove PostgreSQL's global EXECUTE-to-PUBLIC
-- default, so every function in public is revoked explicitly.
revoke all on function public.forbid_append_only_mutation() from public;
