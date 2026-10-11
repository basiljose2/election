-- Baseline security for every relation in `public`, including ones added by later
-- changes: deny-by-default RLS, and no write access for browser-facing roles.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- Runs p_sql as p_role and returns the SQLSTATE it failed with, or 'ok'.
create function pg_temp.try_as(p_role text, p_sql text)
returns text
language plpgsql
as $$
begin
  execute format('set local role %I', p_role);
  begin
    execute p_sql;
  exception when others then
    reset role;
    return sqlstate;
  end;
  reset role;
  return 'ok';
end;
$$;

create temporary table api_roles (role_name text primary key);
insert into api_roles values ('anon'), ('authenticated'), ('service_role');

create temporary view app_relations as
select
  c.oid,
  c.relname,
  c.relkind,
  c.relrowsecurity,
  (
    select a.attname
      from pg_attribute a
     where a.attrelid = c.oid
       and a.attnum > 0
       and not a.attisdropped
       and a.attidentity = ''
       and a.attgenerated = ''
     order by a.attnum
     limit 1
  ) as plain_column
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p', 'v', 'm', 'f');

select ok(
  (select count(*) from app_relations where relkind in ('r', 'p')) >= 6,
  'the foundation tables exist in public'
);

-- Deny-by-default RLS on every table.
select ok(relrowsecurity, format('row level security is enabled on public.%I', relname))
  from app_relations
 where relkind in ('r', 'p');

select is_empty(
  $$ select schemaname, tablename, policyname
       from pg_policies
      where schemaname = 'public'
        and roles && array['public', 'anon', 'authenticated', 'service_role']::name[] $$,
  'no RLS policy applies to public, anon, authenticated or service_role'
);

-- No write privileges for browser-facing roles on any relation.
select ok(
  not (
    has_table_privilege(r.role_name, t.oid, 'INSERT')
    or has_table_privilege(r.role_name, t.oid, 'UPDATE')
    or has_table_privilege(r.role_name, t.oid, 'DELETE')
    or has_table_privilege(r.role_name, t.oid, 'TRUNCATE')
  ),
  format('%s has no write privilege on public.%I', r.role_name, t.relname)
)
from app_relations t
cross join api_roles r;

-- Negative tests: actual write attempts are rejected by the database.
-- (A view that cannot be written at all is refused by the rewriter with 55000 before
-- privileges are even checked; the privilege test above covers its grants.)
select ok(
  pg_temp.try_as(r.role_name, format('insert into public.%I default values', t.relname)) in (
    '42501', case when t.relkind = 'v' then '55000' else '42501' end),
  format('%s cannot INSERT into public.%I', r.role_name, t.relname)
)
from app_relations t
cross join (values ('anon'), ('authenticated')) as r(role_name);

select ok(
  pg_temp.try_as(
    r.role_name,
    format('update public.%I set %I = %I', t.relname, t.plain_column, t.plain_column)
  ) in ('42501', case when t.relkind = 'v' then '55000' else '42501' end),
  format('%s cannot UPDATE public.%I', r.role_name, t.relname)
)
from app_relations t
cross join (values ('anon'), ('authenticated')) as r(role_name)
where t.plain_column is not null;

select ok(
  pg_temp.try_as(r.role_name, format('delete from public.%I', t.relname)) in (
    '42501', case when t.relkind = 'v' then '55000' else '42501' end),
  format('%s cannot DELETE from public.%I', r.role_name, t.relname)
)
from app_relations t
cross join (values ('anon'), ('authenticated')) as r(role_name);

select is(
  pg_temp.try_as(r.role_name, format('truncate public.%I', t.relname)),
  '42501',
  format('%s cannot TRUNCATE public.%I', r.role_name, t.relname)
)
from app_relations t
cross join (values ('anon'), ('authenticated')) as r(role_name)
where t.relkind in ('r', 'p');

-- Browser-facing roles cannot execute any function in public.
select ok(
  not has_function_privilege(r.role_name, p.oid, 'EXECUTE'),
  format('%s cannot execute public.%I', r.role_name, p.proname)
)
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (values ('anon'), ('authenticated')) as r(role_name)
where n.nspname = 'public';

select * from finish();
rollback;
