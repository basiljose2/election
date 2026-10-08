begin;
create extension if not exists pgtap with schema extensions;
-- Let the test session act as the application roles (rolled back with the test).
grant app_server, app_migrator to postgres with set true;
grant usage on schema extensions to app_server, app_migrator;
select plan(20);

-- A fixed election chain for this test.
create temporary table t_ids as
select 'eeeeeeee-1111-0000-0000-000000000001'::uuid as election_id;
grant select on t_ids to app_server, app_migrator, anon, authenticated;

select is(
  public.audit_genesis_hash(null),
  encode(sha256(convert_to('campus-evm/audit-genesis/v1:system', 'UTF8')), 'hex'),
  'the system chain genesis is SHA-256 of the published genesis string'
);

select isnt(
  public.audit_genesis_hash('eeeeeeee-1111-0000-0000-000000000001'),
  public.audit_genesis_hash(null),
  'each election chain has its own genesis value'
);

set local role app_server;

select lives_ok(
  $$ insert into public.audit_events (election_id, seq, prev_hash, hash, payload)
     select election_id, 1, public.audit_genesis_hash(election_id), repeat('a', 64), '{"event_type":"test"}'
       from t_ids $$,
  'app_server can append the first event of a chain'
);

select throws_ok(
  $$ insert into public.audit_events (election_id, seq, prev_hash, hash, payload)
     select election_id, 3, repeat('a', 64), repeat('b', 64), '{}' from t_ids $$,
  'P0001', 'audit chain violation: expected seq 2, got 3',
  'a gap in the sequence is rejected'
);

select throws_ok(
  $$ insert into public.audit_events (election_id, seq, prev_hash, hash, payload)
     select election_id, 1, public.audit_genesis_hash(election_id), repeat('c', 64), '{}' from t_ids $$,
  'P0001', 'audit chain violation: expected seq 2, got 1',
  'a fork (reused sequence number) is rejected'
);

select throws_ok(
  $$ insert into public.audit_events (election_id, seq, prev_hash, hash, payload)
     select election_id, 2, repeat('f', 64), repeat('b', 64), '{}' from t_ids $$,
  'P0001', 'audit chain violation: prev_hash does not match seq 1',
  'a wrong prev_hash is rejected'
);

-- Append-only via privileges (negative tests).
select throws_ok(
  $$ update public.audit_events set payload = '{"event_type":"forged"}' $$,
  '42501', null,
  'app_server cannot UPDATE an Audit Event'
);

select throws_ok(
  $$ delete from public.audit_events $$,
  '42501', null,
  'app_server cannot DELETE an Audit Event'
);

select throws_ok(
  $$ truncate public.audit_events $$,
  '42501', null,
  'app_server cannot TRUNCATE Audit Events'
);

reset role;
set local role app_migrator;

select throws_ok(
  $$ update public.audit_events set payload = '{}' $$,
  '42501', null,
  'app_migrator cannot UPDATE an Audit Event'
);

select throws_ok(
  $$ delete from public.audit_events $$,
  '42501', null,
  'app_migrator cannot DELETE an Audit Event'
);

reset role;
set local role authenticated;

select throws_ok(
  $$ select * from public.audit_events $$,
  '42501', null,
  'authenticated cannot read Audit Events directly'
);

select throws_ok(
  $$ insert into public.audit_events (election_id, seq, prev_hash, hash, payload)
     select election_id, 2, repeat('a', 64), repeat('b', 64), '{}' from t_ids $$,
  '42501', null,
  'authenticated cannot append Audit Events'
);

reset role;

-- Append-only via triggers: even the owner role, which holds every privilege, is rejected.
select throws_ok(
  $$ update public.audit_events set payload = '{"event_type":"forged"}'
      where election_id = (select election_id from t_ids) $$,
  'P0001', 'UPDATE on public.audit_events is not allowed: the table is append-only',
  'the trigger rejects UPDATE by the owner role'
);

select throws_ok(
  $$ delete from public.audit_events where election_id = (select election_id from t_ids) $$,
  'P0001', 'DELETE on public.audit_events is not allowed: the table is append-only',
  'the trigger rejects DELETE by the owner role'
);

select throws_ok(
  $$ truncate public.audit_events $$,
  'P0001', 'TRUNCATE on public.audit_events is not allowed: the table is append-only',
  'the trigger rejects TRUNCATE by the owner role'
);

select is(
  (select payload from public.audit_events where election_id = (select election_id from t_ids)),
  '{"event_type":"test"}'::jsonb,
  'the event is unchanged after the rejected operations'
);

select is(
  (select count(*)::int from public.audit_events where election_id = (select election_id from t_ids)),
  1,
  'the chain still has exactly one event'
);

-- The chain head helper used by server code.
set local role app_server;

select results_eq(
  $$ select last_seq, last_hash from public.audit_chain_head((select election_id from t_ids)) $$,
  $$ values (1::bigint, repeat('a', 64)) $$,
  'audit_chain_head returns the last sequence number and hash'
);

select matches(
  (select occurred_at from public.audit_chain_head(null)),
  '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$',
  'audit_chain_head returns an ISO-8601 UTC server timestamp'
);

reset role;

select * from finish();
rollback;
