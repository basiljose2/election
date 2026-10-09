begin;
create extension if not exists pgtap with schema extensions;
-- Let the test session act as the application roles (rolled back with the test).
grant app_server, app_migrator to postgres with set true;
grant usage on schema extensions to app_server, app_migrator;
select plan(36);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'po1@test.local'),
  ('22222222-2222-2222-2222-222222222222', 'po2@test.local');
insert into public.staff (user_id, email, display_name) values
  ('11111111-1111-1111-1111-111111111111', 'po1@test.local', 'PO 1'),
  ('22222222-2222-2222-2222-222222222222', 'po2@test.local', 'PO 2');

set local role app_server;

insert into public.elections (id, name, polling_date, nota_enabled) values
  ('e0000000-0000-0000-0000-00000000000a', 'Election A', current_date, true),
  ('e0000000-0000-0000-0000-00000000000b', 'Election B', current_date, false);

select is(
  (select status::text from public.elections where id = 'e0000000-0000-0000-0000-00000000000a'),
  'draft', 'a new Election starts in Draft');

-- Posts: seats and names.
select throws_ok(
  $$ insert into public.posts (election_id, name, display_order, seats)
     values ('e0000000-0000-0000-0000-00000000000a', 'Bad', 0, 0) $$,
  '23514', null, 'seats = 0 is rejected');

select throws_ok(
  $$ insert into public.posts (election_id, name, display_order, seats)
     values ('e0000000-0000-0000-0000-00000000000a', 'Bad', 0, -1) $$,
  '23514', null, 'negative seats are rejected');

insert into public.posts (id, election_id, name, display_order, seats) values
  ('a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-00000000000a', 'President', 0, 1),
  ('a0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-00000000000a', 'Council', 1, 2),
  ('b0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-00000000000b', 'President', 0, 1);

select throws_ok(
  $$ insert into public.posts (election_id, name, display_order, seats)
     values ('e0000000-0000-0000-0000-00000000000a', ' president ', 5, 1) $$,
  '23505', null, 'a duplicate Post name (case-insensitive) in one Election is rejected');

-- Candidates.
insert into public.candidates (id, election_id, post_id, name, sort_order) values
  ('c0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-00000000000a',
   'a0000000-0000-0000-0000-000000000001', 'Asha', 0),
  ('c0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-00000000000a',
   'a0000000-0000-0000-0000-000000000001', 'Bilal', 1);

select throws_ok(
  $$ insert into public.candidates (election_id, post_id, name, sort_order)
     values ('e0000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-000000000001', 'asha', 2) $$,
  '23505', null, 'a duplicate Candidate name in one Post is rejected');

select throws_ok(
  $$ insert into public.candidates (election_id, post_id, name, sort_order)
     values ('e0000000-0000-0000-0000-00000000000b', 'a0000000-0000-0000-0000-000000000001', 'Chen', 2) $$,
  '23503', null, 'a Candidate cannot be filed under a Post of another Election');

select throws_ok(
  $$ insert into public.candidates (election_id, post_id, name, sort_order, photo_hash)
     values ('e0000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-000000000001', 'Chen', 2, 'xyz') $$,
  '23514', null, 'a malformed photo hash is rejected');

select throws_ok(
  $$ insert into public.candidates (election_id, post_id, name, sort_order, symbol_text, symbol_hash)
     values ('e0000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-000000000001', 'Chen', 2, 'Star', repeat('a', 64)) $$,
  '23514', null, 'a symbol is either an image or text, not both');

select lives_ok(
  $$ update public.candidates set name = 'Asha K' where id = 'c0000000-0000-0000-0000-000000000001' $$,
  'a Candidate can be renamed in Draft');

select throws_ok(
  $$ update public.candidates set post_id = 'a0000000-0000-0000-0000-000000000002'
      where id = 'c0000000-0000-0000-0000-000000000001' $$,
  '42501', null, 'app_server cannot move a Candidate to another Post');

-- Booths and Booth-Post mapping.
insert into public.booths (id, election_id, name, location) values
  ('d0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-00000000000a', 'Main Hall', 'Block A'),
  ('d0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-00000000000a', 'CS Block', 'Block C'),
  ('d0000000-0000-0000-0000-0000000000b1', 'e0000000-0000-0000-0000-00000000000b', 'Hall B', 'Block B');

insert into public.booth_posts (election_id, booth_id, post_id) values
  ('e0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001');

select throws_ok(
  $$ insert into public.booth_posts (election_id, booth_id, post_id)
     values ('e0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-0000000000b1',
             'a0000000-0000-0000-0000-000000000002') $$,
  '23503', null, 'a booth of Election B cannot be mapped to a Post of Election A');

select throws_ok(
  $$ insert into public.booth_posts (election_id, booth_id, post_id)
     values ('e0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-000000000001',
             'a0000000-0000-0000-0000-000000000001') $$,
  '23505', null, 'the same Booth-Post mapping cannot be stored twice');

-- Presiding Officer assignment.
select lives_ok(
  $$ insert into public.staff_roles (user_id, role, election_id, booth_id)
     values ('11111111-1111-1111-1111-111111111111', 'presiding_officer',
             'e0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-000000000001') $$,
  'a Presiding Officer can be assigned to a booth of the Election');

select throws_ok(
  $$ insert into public.staff_roles (user_id, role, election_id, booth_id)
     values ('22222222-2222-2222-2222-222222222222', 'presiding_officer',
             'e0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-000000000001') $$,
  '23505', null, 'a booth cannot have a second Presiding Officer');

select throws_ok(
  $$ insert into public.staff_roles (user_id, role, election_id, booth_id)
     values ('22222222-2222-2222-2222-222222222222', 'presiding_officer',
             'e0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-0000000000b1') $$,
  '23503', null, 'a Presiding Officer cannot be assigned to a booth of another Election');

select throws_ok(
  $$ insert into public.staff_roles (user_id, role, election_id)
     values ('22222222-2222-2222-2222-222222222222', 'returning_officer', gen_random_uuid()) $$,
  '23503', null, 'a role cannot point at a nonexistent Election');

-- Election updates: freeze_count and status rules.
select throws_ok(
  $$ update public.elections set status = 'frozen', frozen_at = now()
      where id = 'e0000000-0000-0000-0000-00000000000a' $$,
  'P0001', 'freeze must advance freeze_count by one',
  'freezing without advancing freeze_count is rejected');

select throws_ok(
  $$ update public.elections set freeze_count = 5 where id = 'e0000000-0000-0000-0000-00000000000a' $$,
  'P0001', 'freeze_count changes only when freezing',
  'freeze_count cannot be changed outside a freeze');

select lives_ok(
  $$ update public.elections set status = 'frozen', frozen_at = now(), freeze_count = 1
      where id = 'e0000000-0000-0000-0000-00000000000a' $$,
  'an Election can be frozen');

-- Draft-only edits: everything below is a negative test on a Frozen Election.
select throws_ok(
  $$ update public.elections set name = 'Renamed' where id = 'e0000000-0000-0000-0000-00000000000a' $$,
  'P0001', 'an Election can be edited only while it is in Draft',
  'a Frozen Election cannot be renamed');

select throws_ok(
  $$ update public.elections set nota_enabled = false where id = 'e0000000-0000-0000-0000-00000000000a' $$,
  'P0001', 'an Election can be edited only while it is in Draft',
  'the NOTA setting of a Frozen Election cannot change');

select throws_ok(
  $$ update public.candidates set name = 'Changed' where id = 'c0000000-0000-0000-0000-000000000001' $$,
  'P0001', null, 'a Candidate of a Frozen Election cannot be renamed');

select throws_ok(
  $$ insert into public.candidates (election_id, post_id, name, sort_order)
     values ('e0000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-000000000001', 'Late', 9) $$,
  'P0001', null, 'a Candidate cannot be added to a Frozen Election');

select throws_ok(
  $$ delete from public.candidates where id = 'c0000000-0000-0000-0000-000000000001' $$,
  'P0001', null, 'a Candidate of a Frozen Election cannot be deleted');

select throws_ok(
  $$ update public.posts set seats = 3 where id = 'a0000000-0000-0000-0000-000000000002' $$,
  'P0001', null, 'a Post of a Frozen Election cannot be edited');

select throws_ok(
  $$ delete from public.posts where id = 'a0000000-0000-0000-0000-000000000002' $$,
  'P0001', null, 'a Post of a Frozen Election cannot be deleted');

select throws_ok(
  $$ update public.booths set location = 'Elsewhere' where id = 'd0000000-0000-0000-0000-000000000001' $$,
  'P0001', null, 'a booth of a Frozen Election cannot be edited');

select throws_ok(
  $$ delete from public.booth_posts where booth_id = 'd0000000-0000-0000-0000-000000000001' $$,
  'P0001', null, 'a Booth-Post mapping of a Frozen Election cannot be removed');

select throws_ok(
  $$ insert into public.booth_posts (election_id, booth_id, post_id)
     values ('e0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-000000000002',
             'a0000000-0000-0000-0000-000000000002') $$,
  'P0001', null, 'a Booth-Post mapping cannot be added to a Frozen Election');

select lives_ok(
  $$ update public.posts set display_order = 1 where id = 'b0000000-0000-0000-0000-000000000001' $$,
  'Election B (still Draft) remains editable');

-- Unfreeze is blocked once a Ballot Session exists (a fixture table stands in for the
-- ballot-casting-core table; it is rolled back with the test).
reset role;
create table public.ballot_sessions (booth_id uuid not null);
grant select on public.ballot_sessions to app_server;
set local role app_server;

select ok(not public.election_has_ballot_session('e0000000-0000-0000-0000-00000000000a'),
  'no Ballot Session exists yet');

reset role;
insert into public.ballot_sessions values ('d0000000-0000-0000-0000-000000000002');
set local role app_server;

select ok(public.election_has_ballot_session('e0000000-0000-0000-0000-00000000000a'),
  'a fixture Ballot Session is detected');

select throws_ok(
  $$ update public.elections set status = 'draft', frozen_at = null
      where id = 'e0000000-0000-0000-0000-00000000000a' $$,
  'P0001', 'cannot unfreeze: a Ballot Session has been issued in this Election',
  'a Frozen Election with a Ballot Session cannot be unfrozen');

reset role;
delete from public.ballot_sessions;
set local role app_server;

select lives_ok(
  $$ update public.elections set status = 'draft', frozen_at = null
      where id = 'e0000000-0000-0000-0000-00000000000a' $$,
  'with no Ballot Session the Election can be unfrozen');

select throws_ok(
  $$ delete from public.elections where id = 'e0000000-0000-0000-0000-00000000000b' $$,
  '42501', null, 'app_server cannot delete an Election');

reset role;
select throws_ok(
  $$ delete from public.elections where id = 'e0000000-0000-0000-0000-00000000000b' $$,
  'P0001', null, 'even the owner cannot delete an Election (trigger)');

select * from finish();
rollback;
