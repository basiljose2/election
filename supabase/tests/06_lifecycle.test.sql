begin;
create extension if not exists pgtap with schema extensions;
grant app_server, app_migrator to postgres with set true;
grant usage on schema extensions to app_server, app_migrator;
select plan(31);

insert into public.elections (id, name, polling_date)
values ('e0000000-0000-0000-0000-00000000000a', 'Election A', current_date);
insert into public.booths (id, election_id, name, location)
values ('d0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-00000000000a', 'Hall', 'A');

select is((select state::text from public.booth_states where booth_id = 'd0000000-0000-0000-0000-000000000001'),
  'setup', 'a new booth starts in Setup (row created by the database)');

select is((select count(*)::int from public.election_transitions), 6, 'six Election transitions are permitted');
select is((select count(*)::int from public.booth_transitions), 6, 'six booth transitions are permitted');

set local role app_server;

-- Election: illegal transitions are rejected by the database itself (negative tests).
select throws_ok(
  $$ update public.elections set status = 'polling_open', frozen_at = now()
      where id = 'e0000000-0000-0000-0000-00000000000a' $$,
  'P0001', 'illegal Election transition draft -> polling_open', 'Draft cannot jump to Polling Open');
select throws_ok(
  $$ update public.elections set status = 'archived', frozen_at = now()
      where id = 'e0000000-0000-0000-0000-00000000000a' $$,
  'P0001', 'illegal Election transition draft -> archived', 'Draft cannot jump to Archived');

select lives_ok(
  $$ update public.elections set status = 'frozen', frozen_at = now(), freeze_count = 1
      where id = 'e0000000-0000-0000-0000-00000000000a' $$,
  'Draft -> Frozen is permitted');
select throws_ok(
  $$ update public.elections set status = 'polling_completed' where id = 'e0000000-0000-0000-0000-00000000000a' $$,
  'P0001', 'illegal Election transition frozen -> polling_completed', 'Frozen cannot skip Polling Open');
select lives_ok(
  $$ update public.elections set status = 'polling_open' where id = 'e0000000-0000-0000-0000-00000000000a' $$,
  'Frozen -> Polling Open is permitted');
select throws_ok(
  $$ update public.elections set status = 'frozen' where id = 'e0000000-0000-0000-0000-00000000000a' $$,
  'P0001', 'illegal Election transition polling_open -> frozen', 'Polling Open cannot go back to Frozen');
select throws_ok(
  $$ update public.elections set status = 'draft', frozen_at = null where id = 'e0000000-0000-0000-0000-00000000000a' $$,
  'P0001', 'illegal Election transition polling_open -> draft', 'Polling Open cannot be unfrozen');
select throws_ok(
  $$ update public.elections set name = 'Renamed' where id = 'e0000000-0000-0000-0000-00000000000a' $$,
  'P0001', 'an Election can be edited only while it is in Draft', 'a Polling Open Election cannot be edited');
select lives_ok(
  $$ update public.elections set status = 'polling_completed' where id = 'e0000000-0000-0000-0000-00000000000a' $$,
  'Polling Open -> Polling Completed is permitted');
select throws_ok(
  $$ update public.elections set status = 'polling_open' where id = 'e0000000-0000-0000-0000-00000000000a' $$,
  'P0001', 'illegal Election transition polling_completed -> polling_open', 'Polling Completed cannot reopen');
select lives_ok(
  $$ update public.elections set status = 'results_declared' where id = 'e0000000-0000-0000-0000-00000000000a' $$,
  'Polling Completed -> Results Declared is permitted');
select lives_ok(
  $$ update public.elections set status = 'archived' where id = 'e0000000-0000-0000-0000-00000000000a' $$,
  'Results Declared -> Archived is permitted');
select throws_ok(
  $$ update public.elections set status = 'results_declared' where id = 'e0000000-0000-0000-0000-00000000000a' $$,
  'P0001', 'illegal Election transition archived -> results_declared', 'Archived is final');

-- Booth.
select throws_ok(
  $$ update public.booth_states set state = 'open' where booth_id = 'd0000000-0000-0000-0000-000000000001' $$,
  'P0001', 'illegal booth transition setup -> open', 'Setup cannot jump to Open');
select throws_ok(
  $$ update public.booth_states set state = 'closed' where booth_id = 'd0000000-0000-0000-0000-000000000001' $$,
  'P0001', 'illegal booth transition setup -> closed', 'Setup cannot jump to Closed');
select lives_ok(
  $$ update public.booth_states set state = 'mock_poll' where booth_id = 'd0000000-0000-0000-0000-000000000001' $$,
  'Setup -> Mock Poll');
select lives_ok(
  $$ update public.booth_states set state = 'mock_cleared' where booth_id = 'd0000000-0000-0000-0000-000000000001' $$,
  'Mock Poll -> Mock Cleared');
select lives_ok(
  $$ update public.booth_states set state = 'mock_poll' where booth_id = 'd0000000-0000-0000-0000-000000000001' $$,
  'Mock Cleared -> Mock Poll (repeat)');
select lives_ok(
  $$ update public.booth_states set state = 'mock_cleared' where booth_id = 'd0000000-0000-0000-0000-000000000001' $$,
  'Mock Poll -> Mock Cleared again');
select lives_ok(
  $$ update public.booth_states set state = 'open' where booth_id = 'd0000000-0000-0000-0000-000000000001' $$,
  'Mock Cleared -> Open');
select throws_ok(
  $$ update public.booth_states set state = 'mock_poll' where booth_id = 'd0000000-0000-0000-0000-000000000001' $$,
  'P0001', 'illegal booth transition open -> mock_poll', 'an Open booth cannot go back to a mock poll');
select lives_ok(
  $$ update public.booth_states set state = 'closed' where booth_id = 'd0000000-0000-0000-0000-000000000001' $$,
  'Open -> Closed');
select throws_ok(
  $$ update public.booth_states set state = 'open' where booth_id = 'd0000000-0000-0000-0000-000000000001' $$,
  'P0001', 'illegal booth transition closed -> open', 'a Closed booth never reopens');
select lives_ok(
  $$ update public.booth_states set state = 'sealed' where booth_id = 'd0000000-0000-0000-0000-000000000001' $$,
  'Closed -> Sealed');
select throws_ok(
  $$ update public.booth_states set state = 'closed' where booth_id = 'd0000000-0000-0000-0000-000000000001' $$,
  'P0001', 'illegal booth transition sealed -> closed', 'a Sealed booth never changes');

-- Privileges.
select throws_ok(
  $$ insert into public.booth_states (booth_id, state) values (gen_random_uuid(), 'open') $$,
  '42501', null, 'app_server cannot create booth state rows');
select throws_ok(
  $$ delete from public.booth_states $$, '42501', null, 'app_server cannot delete booth state rows');
select throws_ok(
  $$ update public.election_transitions set to_status = 'archived' $$,
  '42501', null, 'app_server cannot edit the SQL transition table');

select * from finish();
rollback;
