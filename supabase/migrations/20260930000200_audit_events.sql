-- Append-only, hash-chained Audit Events (one chain per Election, plus a system chain
-- for events that belong to no Election, e.g. staff management and sign-in).
--
-- hash = SHA-256( prev_hash || canonical_json({ election_id, seq, prev_hash, payload }) )
--
-- The hash itself is computed by server code (src/lib/audit/chain.ts) because it needs
-- canonical JSON; the database enforces the linkage (no gaps, no forks) and immutability.
-- The algorithm is documented in docs/AUDIT_FORMAT.md and checked independently by
-- tools/verifier/verify-audit.mjs.

create table public.audit_events (
  id bigint generated always as identity primary key,
  election_id uuid,
  chain_key uuid generated always as
    (coalesce(election_id, '00000000-0000-0000-0000-000000000000'::uuid)) stored,
  seq bigint not null check (seq >= 1),
  prev_hash text not null check (prev_hash ~ '^[0-9a-f]{64}$'),
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  recorded_at timestamptz not null default now(),
  constraint audit_events_chain_seq_key unique (chain_key, seq)
);

comment on table public.audit_events is
  'Append-only hash-chained audit log. UPDATE/DELETE/TRUNCATE are rejected by grants and triggers.';

-- Published genesis value: the prev_hash of seq 1 in each chain.
create function public.audit_genesis_hash(p_election_id uuid)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(
    sha256(convert_to('campus-evm/audit-genesis/v1:' || coalesce(p_election_id::text, 'system'), 'UTF8')),
    'hex'
  );
$$;

-- Serialises appends per chain for the rest of the transaction.
create function public.audit_lock_chain(p_election_id uuid)
returns void
language sql
set search_path = ''
as $$
  select pg_advisory_xact_lock(
    hashtextextended('campus-evm/audit/' || coalesce(p_election_id::text, 'system'), 0)
  );
$$;

-- Locks the chain and returns its head plus the server timestamp for the next event.
create function public.audit_chain_head(
  p_election_id uuid,
  out last_seq bigint,
  out last_hash text,
  out occurred_at text
)
language plpgsql
set search_path = ''
as $$
begin
  perform public.audit_lock_chain(p_election_id);

  select e.seq, e.hash
    into last_seq, last_hash
    from public.audit_events e
   where e.chain_key = coalesce(p_election_id, '00000000-0000-0000-0000-000000000000'::uuid)
   order by e.seq desc
   limit 1;

  if not found then
    last_seq := 0;
    last_hash := public.audit_genesis_hash(p_election_id);
  end if;

  occurred_at := to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
end;
$$;

-- Defence in depth: even if server code is wrong, a row that does not extend the head
-- of its chain (gap, fork, wrong prev_hash) is rejected.
create function public.audit_events_check_link()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  head_seq bigint;
  head_hash text;
begin
  perform public.audit_lock_chain(new.election_id);

  select e.seq, e.hash
    into head_seq, head_hash
    from public.audit_events e
   where e.chain_key = coalesce(new.election_id, '00000000-0000-0000-0000-000000000000'::uuid)
   order by e.seq desc
   limit 1;

  if not found then
    head_seq := 0;
    head_hash := public.audit_genesis_hash(new.election_id);
  end if;

  if new.seq <> head_seq + 1 then
    raise exception 'audit chain violation: expected seq %, got %', head_seq + 1, new.seq
      using errcode = 'P0001';
  end if;
  if new.prev_hash <> head_hash then
    raise exception 'audit chain violation: prev_hash does not match seq %', head_seq
      using errcode = 'P0001';
  end if;

  new.recorded_at := now();
  return new;
end;
$$;

create trigger audit_events_check_link
  before insert on public.audit_events
  for each row execute function public.audit_events_check_link();

create trigger audit_events_no_update_delete
  before update or delete on public.audit_events
  for each row execute function public.forbid_append_only_mutation();

create trigger audit_events_no_truncate
  before truncate on public.audit_events
  for each statement execute function public.forbid_append_only_mutation();

-- Privileges: INSERT and SELECT only, for app_server only.
revoke all on public.audit_events from public, anon, authenticated, service_role, app_migrator;
grant select, insert on public.audit_events to app_server;

revoke all on function public.audit_genesis_hash(uuid) from public;
revoke all on function public.audit_lock_chain(uuid) from public;
revoke all on function public.audit_chain_head(uuid) from public;
revoke all on function public.audit_events_check_link() from public;
grant execute on function public.audit_genesis_hash(uuid) to app_server;
grant execute on function public.audit_lock_chain(uuid) to app_server;
grant execute on function public.audit_chain_head(uuid) to app_server;

alter table public.audit_events enable row level security;

create policy audit_events_app_server_select on public.audit_events
  for select to app_server using (true);
create policy audit_events_app_server_insert on public.audit_events
  for insert to app_server with check (true);
