begin;
create extension if not exists pgtap with schema extensions;
-- Let the test session act as the application roles (rolled back with the test).
grant app_server, app_migrator to postgres with set true;
grant usage on schema extensions to app_server, app_migrator;
select plan(15);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'admin@test.local'),
  ('22222222-2222-2222-2222-222222222222', 'ro@test.local'),
  ('33333333-3333-3333-3333-333333333333', 'po@test.local');

insert into public.staff (user_id, email, display_name) values
  ('11111111-1111-1111-1111-111111111111', 'admin@test.local', 'Admin'),
  ('22222222-2222-2222-2222-222222222222', 'ro@test.local', 'RO'),
  ('33333333-3333-3333-3333-333333333333', 'po@test.local', 'PO');

-- Scope CHECK constraints (negative tests).
select throws_ok(
  $$ insert into public.staff_roles (user_id, role, election_id)
     values ('33333333-3333-3333-3333-333333333333', 'presiding_officer', gen_random_uuid()) $$,
  '23514', null,
  'a Presiding Officer row without a booth_id is rejected'
);

select throws_ok(
  $$ insert into public.staff_roles (user_id, role)
     values ('22222222-2222-2222-2222-222222222222', 'returning_officer') $$,
  '23514', null,
  'a Returning Officer row without an election_id is rejected'
);

select throws_ok(
  $$ insert into public.staff_roles (user_id, role, election_id, booth_id)
     values ('22222222-2222-2222-2222-222222222222', 'returning_officer', gen_random_uuid(), gen_random_uuid()) $$,
  '23514', null,
  'a Returning Officer row with a booth_id is rejected'
);

select throws_ok(
  $$ insert into public.staff_roles (user_id, role)
     values ('22222222-2222-2222-2222-222222222222', 'observer') $$,
  '23514', null,
  'an Observer row without an election_id is rejected'
);

select throws_ok(
  $$ insert into public.staff_roles (user_id, role, election_id)
     values ('11111111-1111-1111-1111-111111111111', 'super_admin', gen_random_uuid()) $$,
  '23514', null,
  'a Super Admin row scoped to an election is rejected'
);

-- Valid assignments, inserted as the application role.
set local role app_server;

select lives_ok(
  $$ insert into public.staff_roles (id, user_id, role, election_id, booth_id)
     values ('aaaaaaaa-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333',
             'presiding_officer', 'eeeeeeee-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001') $$,
  'a Presiding Officer row with an election and a booth is accepted'
);

select lives_ok(
  $$ insert into public.staff_roles (user_id, role, election_id)
     values ('22222222-2222-2222-2222-222222222222', 'returning_officer', 'eeeeeeee-0000-0000-0000-000000000001') $$,
  'a Returning Officer row with an election is accepted'
);

select lives_ok(
  $$ insert into public.staff_roles (user_id, role)
     values ('11111111-1111-1111-1111-111111111111', 'super_admin') $$,
  'a global Super Admin row is accepted'
);

select throws_ok(
  $$ insert into public.staff_roles (user_id, role, election_id)
     values ('22222222-2222-2222-2222-222222222222', 'returning_officer', 'eeeeeeee-0000-0000-0000-000000000001') $$,
  '23505', null,
  'a duplicate active assignment is rejected'
);

-- Assignments change only by being revoked, once.
select throws_ok(
  $$ update public.staff_roles set role = 'observer'
      where id = 'aaaaaaaa-0000-0000-0000-000000000001' $$,
  '42501', null,
  'app_server cannot change the role of an assignment'
);

select lives_ok(
  $$ update public.staff_roles
        set revoked_at = now(), revoked_by = '11111111-1111-1111-1111-111111111111'
      where id = 'aaaaaaaa-0000-0000-0000-000000000001' $$,
  'an assignment can be revoked'
);

select throws_ok(
  $$ update public.staff_roles set revoked_at = now()
      where id = 'aaaaaaaa-0000-0000-0000-000000000001' $$,
  'P0001', 'staff_roles rows can only be revoked, once',
  'a revoked assignment cannot be changed again'
);

select throws_ok(
  $$ delete from public.staff_roles where id = 'aaaaaaaa-0000-0000-0000-000000000001' $$,
  '42501', null,
  'app_server cannot delete an assignment'
);

reset role;

select throws_ok(
  $$ delete from public.staff_roles where id = 'aaaaaaaa-0000-0000-0000-000000000001' $$,
  'P0001', null,
  'even the owner cannot delete an assignment (trigger)'
);

set local role app_server;
select throws_ok(
  $$ update public.staff set email = 'x@test.local'
      where user_id = '11111111-1111-1111-1111-111111111111' $$,
  '42501', null,
  'app_server cannot change a staff email address'
);
reset role;

select * from finish();
rollback;
