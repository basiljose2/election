-- Terminal state helpers, offline reporting, and Realtime channel authorization.

-- The booth's state as terminals see it: the booth's own state once election-state-machines
-- provides `booth_states`, otherwise the Election's status.
create function public.booth_state(p_booth_id uuid)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_state text;
begin
  if to_regclass('public.booth_states') is not null then
    execute 'select state::text from public.booth_states where booth_id = $1' into v_state using p_booth_id;
  end if;
  if v_state is null then
    select e.status::text into v_state
      from public.booths b join public.elections e on e.id = b.election_id
     where b.id = p_booth_id;
  end if;
  return v_state;
end;
$$;

-- Ballots cast at the booth so far (Master Terminal only). ballot_sessions belongs to
-- ballot-casting-core (booth_id, status); until it exists the count is 0. It is a count of
-- sessions, never a link to any Vote Selection.
create function public.booth_ballots_cast(p_booth_id uuid)
returns bigint
language plpgsql
stable
set search_path = ''
as $$
declare
  v_count bigint;
begin
  if to_regclass('public.ballot_sessions') is null then
    return 0;
  end if;
  execute 'select count(*) from public.ballot_sessions where booth_id = $1 and status::text = ''cast'' and not coalesce(is_mock, false)'
    into v_count using p_booth_id;
  return v_count;
end;
$$;

-- The heartbeat value for which an offline transition was already audited.
alter table public.terminal_heartbeats add column offline_reported_for timestamptz;
grant update (offline_reported_for) on public.terminal_heartbeats to app_server;

revoke all on function public.booth_state(uuid) from public;
revoke all on function public.booth_ballots_cast(uuid) from public;
grant execute on function public.booth_state(uuid) to app_server;
grant execute on function public.booth_ballots_cast(uuid) to app_server;

-- Realtime authorization. Terminals subscribe with a server-minted JWT (role `authenticated`
-- plus booth_id / terminal_type claims). They may RECEIVE broadcasts on exactly their booth's
-- topic. No INSERT policy exists, so no client can publish: only the server (secret key) can.
create policy "booth terminals receive their own booth signals"
  on realtime.messages
  for select
  to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and (auth.jwt() ->> 'terminal_type') in ('master', 'voting')
    and (auth.jwt() ->> 'booth_id') is not null
    and (select realtime.topic()) = 'booth:' || (auth.jwt() ->> 'booth_id')
  );
