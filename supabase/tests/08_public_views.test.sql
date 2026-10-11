begin;
create extension if not exists pgtap with schema extensions;
grant app_server, app_migrator to postgres with set true;
grant usage on schema extensions to app_server, app_migrator, anon;
select plan(17);

insert into public.elections (id, name, polling_date, nota_enabled) values
  ('e0000000-0000-0000-0000-0000000000d1', 'Draft election', current_date, false),
  ('e0000000-0000-0000-0000-0000000000f1', 'Frozen election', current_date, true);
insert into public.booths (id, election_id, name, location) values
  ('d0000000-0000-0000-0000-0000000000d1', 'e0000000-0000-0000-0000-0000000000d1', 'Draft booth', 'A'),
  ('d0000000-0000-0000-0000-0000000000f1', 'e0000000-0000-0000-0000-0000000000f1', 'Frozen booth', 'B');
update public.elections set status = 'frozen', frozen_at = now(), freeze_count = 1
 where id = 'e0000000-0000-0000-0000-0000000000f1';
update public.booth_counters set ballots_cast = 3, ballots_cancelled = 1
 where booth_id = 'd0000000-0000-0000-0000-0000000000f1';

-- ---- What `anon` can see
set local role anon;

select is(
  (select array_agg(name order by name) from public.public_elections
    where id in ('e0000000-0000-0000-0000-0000000000d1', 'e0000000-0000-0000-0000-0000000000f1')),
  array['Frozen election'], 'a Draft Election is not public');
select is(
  (select count(*) from public.public_booth_status
    where election_id = 'e0000000-0000-0000-0000-0000000000d1'),
  0::bigint, 'booths of a Draft Election are not public');
select is(
  (select ballots_cast::int || '/' || ballots_cancelled::int from public.public_booth_status
    where booth_id = 'd0000000-0000-0000-0000-0000000000f1'),
  '3/1', 'the live board exposes turnout totals');
select is(
  (select array_agg(column_name::text order by column_name)
     from information_schema.columns
    where table_schema = 'public' and table_name = 'public_booth_status'),
  array['ballots_cancelled', 'ballots_cast', 'booth_id', 'election_id', 'location', 'name', 'state'],
  'the booth view carries no staff, terminal or candidate columns');
select is_empty(
  $$ select * from public.public_results where election_id = 'e0000000-0000-0000-0000-0000000000f1' $$,
  'no Result exists before declaration');
select is_empty(
  $$ select * from public.public_booth_tallies where election_id = 'e0000000-0000-0000-0000-0000000000f1' $$,
  'no Booth Tally exists yet');

-- ---- ... and what it cannot
select throws_ok($$ select * from public.vote_selections $$, '42501', null,
  'anon cannot read Vote Selections');
select throws_ok($$ select * from public.staff $$, '42501', null, 'anon cannot read staff');
select throws_ok($$ select * from public.audit_events $$, '42501', null,
  'anon cannot read the audit log directly');
select throws_ok($$ select * from public.ballot_sessions $$, '42501', null,
  'anon cannot read Ballot Sessions');
select throws_ok($$ select * from public.elections $$, '42501', null,
  'anon cannot read the Election table (Drafts included)');
select throws_ok($$ select * from public.booth_tallies $$, '42501', null,
  'anon cannot read the tally table, only its public view');
select throws_ok($$ select * from public.verification_bundles $$, '42501', null,
  'anon cannot read the stored bundle table');
select throws_ok(
  $$ select * from public.export_booth_selections('e0000000-0000-0000-0000-0000000000f1') $$,
  '42501', null, 'anon cannot call the vote export');
select throws_ok(
  $$ insert into public.results (election_id, canonical_json, result_hash, signature)
     values ('e0000000-0000-0000-0000-0000000000f1', '{}', repeat('a', 64), repeat('A', 86)) $$,
  '42501', null, 'anon cannot write anything');

-- ---- The export is sealed until results are declared, even for the application role
reset role;
set local role app_server;
select throws_ok(
  $$ select * from public.export_booth_selections('e0000000-0000-0000-0000-0000000000f1') $$,
  '42501', 'Vote Selections are exported only after results are declared',
  'the export is refused while the Election is not Results Declared');
select is_empty(
  $$ select 1 from pg_auth_members m
       join pg_roles r on r.oid = m.roleid and r.rolname = 'vote_reader'
       join pg_roles u on u.oid = m.member where u.rolname = 'anon' $$,
  'anon is not a member of the reader role');

select * from finish();
rollback;
