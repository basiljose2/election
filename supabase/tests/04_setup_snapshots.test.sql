begin;
create extension if not exists pgtap with schema extensions;
grant app_server, app_migrator to postgres with set true;
grant usage on schema extensions to app_server, app_migrator;
select plan(11);

insert into public.elections (id, name, polling_date)
values ('e0000000-0000-0000-0000-00000000000a', 'Election A', current_date);
insert into public.booths (id, election_id, name, location)
values ('d0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-00000000000a', 'Main Hall', 'A');

set local role app_server;

select lives_ok(
  $$ insert into public.setup_snapshots (id, election_id, freeze_no, canonical_json, setup_hash)
     values ('f0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-00000000000a', 1, '{"a":1}',
             encode(sha256(convert_to('{"a":1}', 'UTF8')), 'hex')) $$,
  'a snapshot whose hash matches its canonical JSON is stored');

select throws_ok(
  $$ insert into public.setup_snapshots (election_id, freeze_no, canonical_json, setup_hash)
     values ('e0000000-0000-0000-0000-00000000000a', 2, '{"a":2}', repeat('0', 64)) $$,
  '23514', null, 'a snapshot whose hash does not match its canonical JSON is rejected');

select throws_ok(
  $$ insert into public.setup_snapshots (election_id, freeze_no, canonical_json, setup_hash)
     values ('e0000000-0000-0000-0000-00000000000a', 1, '{"a":1}',
             encode(sha256(convert_to('{"a":1}', 'UTF8')), 'hex')) $$,
  '23505', null, 'a freeze generation cannot be stored twice');

select lives_ok(
  $$ insert into public.ballot_definitions (election_id, freeze_no, booth_id, canonical_json, definition_hash)
     values ('e0000000-0000-0000-0000-00000000000a', 1, 'd0000000-0000-0000-0000-000000000001', '{"b":1}',
             encode(sha256(convert_to('{"b":1}', 'UTF8')), 'hex')) $$,
  'a Ballot Definition whose hash matches is stored');

select throws_ok(
  $$ insert into public.ballot_definitions (election_id, freeze_no, booth_id, canonical_json, definition_hash)
     values ('e0000000-0000-0000-0000-00000000000a', 1, 'd0000000-0000-0000-0000-000000000001', '{"b":2}',
             encode(sha256(convert_to('{"b":2}', 'UTF8')), 'hex')) $$,
  '23505', null, 'a booth has one Ballot Definition per freeze generation');

-- Immutability (negative tests).
select throws_ok(
  $$ update public.ballot_definitions set canonical_json = '{"b":3}' $$,
  '42501', null, 'app_server cannot UPDATE a Ballot Definition');
select throws_ok(
  $$ delete from public.ballot_definitions $$,
  '42501', null, 'app_server cannot DELETE a Ballot Definition');
select throws_ok(
  $$ update public.setup_snapshots set setup_hash = repeat('0', 64) $$,
  '42501', null, 'app_server cannot UPDATE a setup snapshot');
select throws_ok(
  $$ delete from public.setup_snapshots $$,
  '42501', null, 'app_server cannot DELETE a setup snapshot');

reset role;

select throws_ok(
  $$ update public.ballot_definitions set canonical_json = '{"b":3}' $$,
  'P0001', null, 'even the owner cannot UPDATE a Ballot Definition (trigger)');
select throws_ok(
  $$ delete from public.setup_snapshots $$,
  'P0001', null, 'even the owner cannot DELETE a setup snapshot (trigger)');

select * from finish();
rollback;
