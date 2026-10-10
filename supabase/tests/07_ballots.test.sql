begin;
create extension if not exists pgtap with schema extensions;
grant app_server, app_migrator to postgres with set true;
grant usage on schema extensions to app_server, app_migrator;
select plan(43);

insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111', 'po@test.local');
insert into public.staff (user_id, email, display_name)
values ('11111111-1111-1111-1111-111111111111', 'po@test.local', 'PO');
insert into public.elections (id, name, polling_date, nota_enabled)
values ('e0000000-0000-0000-0000-00000000000a', 'Election A', current_date, true);
insert into public.posts (id, election_id, name, display_order, seats)
values ('a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-00000000000a', 'President', 0, 1);
insert into public.candidates (id, election_id, post_id, name, sort_order) values
  ('c0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-000000000001', 'Asha', 0),
  ('c0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-000000000001', 'Bilal', 1);
insert into public.booths (id, election_id, name, location)
values ('d0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-00000000000a', 'Hall', 'A');
insert into public.terminals (id, election_id, booth_id, type, credential_hash)
values ('f0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-00000000000a',
        'd0000000-0000-0000-0000-000000000001', 'voting', repeat('a', 64));
update public.elections set status = 'frozen', frozen_at = now(), freeze_count = 1
 where id = 'e0000000-0000-0000-0000-00000000000a';
update public.elections set status = 'polling_open' where id = 'e0000000-0000-0000-0000-00000000000a';

-- ---- Schema: nothing in vote_selections can order, time or link a vote (task 1.1)
select is(
  (select array_agg(column_name::text order by column_name)
     from information_schema.columns
    where table_schema = 'public' and table_name = 'vote_selections'),
  array['booth_id','candidate_id','election_id','id','is_mock','is_nota','mock_round','post_id','signature'],
  'vote_selections has exactly the permitted columns');

select is_empty(
  $$ select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'vote_selections'
        and (data_type like 'timestamp%' or data_type = 'date' or data_type = 'time without time zone'
             or data_type like 'time%' or column_default like 'nextval%' or is_identity = 'YES'
             or column_name ~* '(session|terminal|staff|user|created|updated|issued|cast_at|seq|order|serial)') $$,
  'vote_selections has no timestamp, sequence, identity or session/terminal/staff column');

select is_empty(
  $$ select 1 from pg_constraint c
      where c.contype = 'f'
        and (c.conrelid = 'public.vote_selections'::regclass
             and c.confrelid in ('public.ballot_sessions'::regclass, 'public.terminals'::regclass,
                                 'public.staff'::regclass, 'public.vote_selections'::regclass)) $$,
  'vote_selections references no session, terminal, staff member or other vote');

select is_empty(
  $$ select 1 from pg_constraint c
      where c.contype = 'f' and c.confrelid = 'public.vote_selections'::regclass $$,
  'nothing references vote_selections');

select is_empty(
  $$ select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'ballot_sessions'
        and column_name ~* '(candidate|choice|selection|vote|nota)' $$,
  'ballot_sessions has no column that could hold a choice');

-- ---- Privileges (task 1.2)
set local role app_server;

select lives_ok(
  $$ insert into public.vote_selections (id, election_id, booth_id, post_id, candidate_id, signature)
     values ('b0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-00000000000a',
             'd0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
             'c0000000-0000-0000-0000-000000000001', repeat('A', 86)) $$,
  'app_server can INSERT a Vote Selection');

select lives_ok(
  $$ insert into public.vote_selections (election_id, booth_id, post_id, is_nota, signature)
     values ('e0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-000000000001',
             'a0000000-0000-0000-0000-000000000001', true, repeat('B', 86)) $$,
  'a NOTA selection can be inserted');

select throws_ok($$ select * from public.vote_selections $$, '42501', null,
  'app_server cannot SELECT Vote Selections');
select throws_ok($$ select count(*) from public.vote_selections $$, '42501', null,
  'app_server cannot even COUNT Vote Selections');
select throws_ok($$ select candidate_id from public.vote_selections $$, '42501', null,
  'app_server cannot SELECT a single column of Vote Selections');
select throws_ok(
  $$ insert into public.vote_selections (election_id, booth_id, post_id, is_nota, signature)
     values ('e0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-000000000001',
             'a0000000-0000-0000-0000-000000000001', true, repeat('C', 86)) returning id $$,
  '42501', null, 'app_server cannot read back what it inserted (RETURNING needs SELECT)');
select throws_ok($$ update public.vote_selections set candidate_id = null $$, '42501', null,
  'app_server cannot UPDATE Vote Selections');
select throws_ok($$ delete from public.vote_selections $$, '42501', null,
  'app_server cannot DELETE Vote Selections');
select throws_ok($$ truncate public.vote_selections $$, '42501', null,
  'app_server cannot TRUNCATE Vote Selections');

select throws_ok(
  $$ insert into public.vote_selections (election_id, booth_id, post_id, candidate_id, is_nota, signature)
     values ('e0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-000000000001',
             'a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', true, repeat('D', 86)) $$,
  '23514', null, 'a selection cannot be both a Candidate and NOTA');
select throws_ok(
  $$ insert into public.vote_selections (election_id, booth_id, post_id, signature)
     values ('e0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-000000000001',
             'a0000000-0000-0000-0000-000000000001', repeat('D', 86)) $$,
  '23514', null, 'a selection must be a Candidate or NOTA');
select throws_ok(
  $$ insert into public.vote_selections (election_id, booth_id, post_id, candidate_id, is_mock, signature)
     values ('e0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-000000000001',
             'a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', true, repeat('D', 86)) $$,
  '23514', null, 'a mock selection must carry its mock round');
select throws_ok(
  $$ insert into public.vote_selections (election_id, booth_id, post_id, candidate_id, signature)
     values ('e0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-000000000001',
             'a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'not-a-signature') $$,
  '23514', null, 'a malformed signature is rejected');

reset role;
select throws_ok(
  $$ update public.vote_selections set is_nota = false where id = 'b0000000-0000-0000-0000-000000000001' $$,
  'P0001', null, 'even the owner cannot UPDATE a Vote Selection (trigger)');
select throws_ok(
  $$ delete from public.vote_selections where id = 'b0000000-0000-0000-0000-000000000001' $$,
  'P0001', null, 'even the owner cannot DELETE a Vote Selection (trigger)');
select throws_ok($$ truncate public.vote_selections $$, 'P0001', null,
  'even the owner cannot TRUNCATE Vote Selections (trigger)');

-- ---- Ballot Sessions
set local role app_server;

select lives_ok(
  $$ insert into public.ballot_sessions (id, election_id, booth_id, terminal_id, is_mock, issued_by)
     values ('50000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-00000000000a',
             'd0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001',
             false, '11111111-1111-1111-1111-111111111111') $$,
  'a pending Ballot Session can be issued');

select throws_ok(
  $$ insert into public.ballot_sessions (election_id, booth_id, terminal_id, is_mock, issued_by)
     values ('e0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-000000000001',
             'f0000000-0000-0000-0000-000000000001', false, '11111111-1111-1111-1111-111111111111') $$,
  '23505', null, 'a booth cannot have two pending Ballot Sessions');

select lives_ok(
  $$ update public.ballot_sessions
        set status = 'cast', finished_at = now(), idempotency_key_hash = repeat('1', 64)
      where id = '50000000-0000-0000-0000-000000000001' $$,
  'a pending Ballot Session can be marked Cast');

select throws_ok(
  $$ update public.ballot_sessions set status = 'cancelled', cancel_reason = 'voter_left'
      where id = '50000000-0000-0000-0000-000000000001' $$,
  'P0001', 'a cast Ballot Session cannot change', 'a Cast Ballot Session cannot change (negative test)');
select throws_ok(
  $$ update public.ballot_sessions set idempotency_key_hash = repeat('2', 64)
      where id = '50000000-0000-0000-0000-000000000001' $$,
  'P0001', null, 'a Cast Ballot Session cannot get another idempotency key');
select throws_ok($$ delete from public.ballot_sessions $$, '42501', null,
  'app_server cannot DELETE Ballot Sessions');
select throws_ok(
  $$ update public.ballot_sessions set booth_id = gen_random_uuid() $$,
  '42501', null, 'app_server cannot move a Ballot Session to another booth');

reset role;
select throws_ok(
  $$ delete from public.ballot_sessions where id = '50000000-0000-0000-0000-000000000001' $$,
  'P0001', null, 'even the owner cannot delete a Ballot Session (trigger)');

-- Cancelled sessions are final too, and need a reason.
set local role app_server;
select lives_ok(
  $$ insert into public.ballot_sessions (id, election_id, booth_id, terminal_id, is_mock, issued_by)
     values ('50000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-00000000000a',
             'd0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001',
             false, '11111111-1111-1111-1111-111111111111') $$,
  'another pending session can be issued once the first is finished');
select throws_ok(
  $$ update public.ballot_sessions set status = 'cancelled', finished_at = now()
      where id = '50000000-0000-0000-0000-000000000002' $$,
  '23514', null, 'cancelling needs a reason');
select lives_ok(
  $$ update public.ballot_sessions set status = 'cancelled', finished_at = now(), cancel_reason = 'voter_left'
      where id = '50000000-0000-0000-0000-000000000002' $$,
  'a pending Ballot Session can be cancelled with a reason');
select throws_ok(
  $$ update public.ballot_sessions set status = 'pending', finished_at = null, cancel_reason = null
      where id = '50000000-0000-0000-0000-000000000002' $$,
  'P0001', null, 'a cancelled Ballot Session cannot be revived');

-- ---- Sealed readers (task 1.3)
select throws_ok(
  $$ select * from public.election_tally('e0000000-0000-0000-0000-00000000000a') $$,
  '42501', 'per-candidate counts are sealed until polling is completed',
  'election_tally raises while the Election is Polling Open (negative test)');

select throws_ok(
  $$ select * from public.booth_integrity_digest('d0000000-0000-0000-0000-000000000001') $$,
  '42501', null, 'the integrity digest is refused while the booth is not closed');

-- mock_counts returns only mock rows of the current round.
reset role;
update public.booth_counters set mock_round = 2 where booth_id = 'd0000000-0000-0000-0000-000000000001';
insert into public.vote_selections (election_id, booth_id, post_id, candidate_id, is_mock, mock_round, signature)
values
  ('e0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', true, 2, repeat('E', 86)),
  ('e0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', true, 2, repeat('F', 86)),
  ('e0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000002', true, 1, repeat('G', 86));
set local role app_server;

select is(
  (select votes from public.mock_counts('d0000000-0000-0000-0000-000000000001', 2)
    where candidate_id = 'c0000000-0000-0000-0000-000000000001'),
  2::bigint, 'mock_counts reports the current round''s mock votes');
select is_empty(
  $$ select * from public.mock_counts('d0000000-0000-0000-0000-000000000001', 1) $$,
  'mock_counts reports nothing for an earlier round');
select is(
  (select sum(votes)::int from public.mock_counts('d0000000-0000-0000-0000-000000000001', 2)),
  2, 'the real votes are never included in mock counts');

-- After polling completes the tally exists and excludes mock rows.
reset role;
update public.elections set status = 'polling_completed' where id = 'e0000000-0000-0000-0000-00000000000a';
set local role app_server;
select is(
  (select sum(votes)::int from public.election_tally('e0000000-0000-0000-0000-00000000000a')),
  2, 'election_tally works once polling is completed and counts only real votes');
select is(
  (select votes from public.election_tally('e0000000-0000-0000-0000-00000000000a') where is_nota),
  1::bigint, 'election_tally reports NOTA separately');

-- The digest needs a closed booth.
reset role;
update public.booth_states set state = 'mock_poll' where booth_id = 'd0000000-0000-0000-0000-000000000001';
update public.booth_states set state = 'mock_cleared' where booth_id = 'd0000000-0000-0000-0000-000000000001';
update public.booth_states set state = 'open' where booth_id = 'd0000000-0000-0000-0000-000000000001';
update public.booth_states set state = 'closed' where booth_id = 'd0000000-0000-0000-0000-000000000001';
set local role app_server;
select is(
  (select ballot_rows from public.booth_integrity_digest('d0000000-0000-0000-0000-000000000001')),
  2::bigint, 'the digest of a closed booth counts its real Vote Selections only');
select matches(
  (select digest from public.booth_integrity_digest('d0000000-0000-0000-0000-000000000001')),
  '^[0-9a-f]{64}$', 'the digest is a SHA-256 value, with no per-candidate counts');

-- app_server is not a member of the reader role, so it cannot become it.
select is_empty(
  $$ select 1 from pg_auth_members m
       join pg_roles r on r.oid = m.roleid and r.rolname = 'vote_reader'
       join pg_roles u on u.oid = m.member
      where u.rolname in ('app_server', 'anon', 'authenticated', 'service_role') $$,
  'no application or API role is a member of vote_reader');

select * from finish();
rollback;
