begin;
create extension if not exists pgtap with schema extensions;
grant app_server, app_migrator to postgres with set true;
grant usage on schema extensions to app_server, app_migrator;
select plan(24);

insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111', 'po@test.local');
insert into public.staff (user_id, email, display_name)
values ('11111111-1111-1111-1111-111111111111', 'po@test.local', 'PO');
insert into public.elections (id, name, polling_date)
values ('e0000000-0000-0000-0000-00000000000a', 'Election A', current_date);
insert into public.booths (id, election_id, name, location) values
  ('d0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-00000000000a', 'Hall', 'A'),
  ('d0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-00000000000a', 'Annex', 'B');

set local role app_server;

select lives_ok(
  $$ insert into public.terminals (id, election_id, booth_id, type, credential_hash)
     values ('a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-00000000000a',
             'd0000000-0000-0000-0000-000000000001', 'master', repeat('a', 64)) $$,
  'a Master Terminal can be registered');

select throws_ok(
  $$ insert into public.terminals (election_id, booth_id, type, credential_hash)
     values ('e0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-000000000001', 'master', repeat('b', 64)) $$,
  '23505', null, 'a booth cannot have two active Master Terminals');

select lives_ok(
  $$ insert into public.terminals (id, election_id, booth_id, type, credential_hash, device_id)
     values ('a0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-00000000000a',
             'd0000000-0000-0000-0000-000000000001', 'voting', repeat('c', 64), 'AB12') $$,
  'the same booth can have one Voting Terminal');

select throws_ok(
  $$ insert into public.terminals (election_id, booth_id, type, credential_hash)
     values ('e0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-000000000001', 'voting', repeat('d', 64)) $$,
  '23505', null, 'a booth cannot have two active Voting Terminals');

select throws_ok(
  $$ insert into public.terminals (election_id, booth_id, type, credential_hash)
     values ('e0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-000000000002', 'voting', repeat('c', 64)) $$,
  '23505', null, 'a credential hash is unique');

select throws_ok(
  $$ insert into public.terminals (election_id, booth_id, type, credential_hash)
     values ('e0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-000000000002', 'voting', 'plaintext-token') $$,
  '23514', null, 'only a SHA-256 hex digest is accepted as a credential hash');

select throws_ok(
  $$ insert into public.terminals (election_id, booth_id, type, credential_hash)
     values ('e0000000-0000-0000-0000-00000000000b', 'd0000000-0000-0000-0000-000000000002', 'voting', repeat('e', 64)) $$,
  '23503', null, 'a terminal cannot name a booth of a different Election');

-- Revocation is the only change, and only once.
select throws_ok(
  $$ update public.terminals set status = 'revoked' where id = 'a0000000-0000-0000-0000-000000000002' $$,
  '23514', null, 'revoking needs a time and a reason');

select lives_ok(
  $$ update public.terminals set status = 'revoked', revoked_at = now(), revoked_reason = 'replaced'
      where id = 'a0000000-0000-0000-0000-000000000002' $$,
  'a terminal can be revoked');

select lives_ok(
  $$ insert into public.terminals (election_id, booth_id, type, credential_hash)
     values ('e0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-000000000001', 'voting', repeat('f', 64)) $$,
  'after revocation a replacement Voting Terminal can be registered');

select throws_ok(
  $$ update public.terminals set status = 'active', revoked_at = null, revoked_reason = null
      where id = 'a0000000-0000-0000-0000-000000000002' $$,
  'P0001', 'terminals can only be revoked, once', 'a revoked terminal cannot be reactivated');

select throws_ok(
  $$ update public.terminals set credential_hash = repeat('9', 64)
      where id = 'a0000000-0000-0000-0000-000000000001' $$,
  '42501', null, 'app_server cannot change a credential hash');

select throws_ok(
  $$ delete from public.terminals $$, '42501', null, 'app_server cannot delete terminals');

-- Pairing codes.
select lives_ok(
  $$ insert into public.pairing_codes (id, election_id, booth_id, code_hash, expires_at, created_by)
     values ('c0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-00000000000a',
             'd0000000-0000-0000-0000-000000000001', repeat('1', 64), now() + interval '2 minutes',
             '11111111-1111-1111-1111-111111111111') $$,
  'a pairing code can be stored');

select throws_ok(
  $$ insert into public.pairing_codes (election_id, booth_id, code_hash, expires_at, created_by)
     values ('e0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-000000000001', repeat('2', 64),
             now() + interval '2 minutes', '11111111-1111-1111-1111-111111111111') $$,
  '23505', null, 'a booth has at most one live pairing code');

select throws_ok(
  $$ update public.pairing_codes set attempts = 6 where id = 'c0000000-0000-0000-0000-000000000001' $$,
  '23514', null, 'more than 5 attempts cannot be recorded');

select throws_ok(
  $$ update public.pairing_codes set expires_at = now() + interval '1 day'
      where id = 'c0000000-0000-0000-0000-000000000001' $$,
  '42501', null, 'app_server cannot extend a pairing code');

select lives_ok(
  $$ update public.pairing_codes set status = 'invalidated' where id = 'c0000000-0000-0000-0000-000000000001' $$,
  'a pairing code can be invalidated');

select throws_ok(
  $$ update public.pairing_codes set status = 'active' where id = 'c0000000-0000-0000-0000-000000000001' $$,
  'P0001', null, 'a finished pairing code cannot be reactivated');

-- Booth phase and pending-session helpers.
select ok(not public.booth_accepts_terminals('d0000000-0000-0000-0000-000000000001'),
  'a booth of a Draft Election does not accept terminals');

reset role;
update public.elections set status = 'frozen', frozen_at = now(), freeze_count = 1
 where id = 'e0000000-0000-0000-0000-00000000000a';
set local role app_server;

select ok(public.booth_accepts_terminals('d0000000-0000-0000-0000-000000000001'),
  'a booth of a Frozen Election accepts terminals');

reset role;
create table public.booth_states (booth_id uuid primary key, state text not null);
grant select on public.booth_states to app_server;
insert into public.booth_states values ('d0000000-0000-0000-0000-000000000001', 'closed');
set local role app_server;

select ok(not public.booth_accepts_terminals('d0000000-0000-0000-0000-000000000001'),
  'a Closed booth (fixture) does not accept terminals');

reset role;
create table public.ballot_sessions (booth_id uuid not null, status text not null);
grant select on public.ballot_sessions to app_server;
insert into public.ballot_sessions values ('d0000000-0000-0000-0000-000000000001', 'pending');
set local role app_server;

select ok(public.booth_has_pending_ballot_session('d0000000-0000-0000-0000-000000000001'),
  'a pending Ballot Session (fixture) is detected');

select is(public.bump_booth_state_version('d0000000-0000-0000-0000-000000000001') + 1,
  public.bump_booth_state_version('d0000000-0000-0000-0000-000000000001'),
  'the booth state version increases by one each time');

select * from finish();
rollback;
