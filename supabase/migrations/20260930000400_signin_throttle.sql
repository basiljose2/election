-- Sign-in rate limiting: at most 5 failed attempts per account in a sliding 15-minute
-- window; reaching the limit locks the account's sign-in for 15 minutes.
-- account_key is the normalised (lower-cased, trimmed) email address.

create table public.signin_attempts (
  id bigint generated always as identity primary key,
  account_key text not null check (length(account_key) between 1 and 320),
  attempted_at timestamptz not null,
  -- null while the attempt is in flight; an unresolved attempt counts as a failure.
  outcome text check (outcome in ('success', 'failure'))
);

create index signin_attempts_account_idx on public.signin_attempts (account_key, attempted_at desc);

create table public.signin_lockouts (
  id bigint generated always as identity primary key,
  account_key text not null check (length(account_key) between 1 and 320),
  locked_at timestamptz not null,
  locked_until timestamptz not null,
  constraint signin_lockouts_window check (locked_until > locked_at)
);

create index signin_lockouts_account_idx on public.signin_lockouts (account_key, locked_until desc);

revoke all on public.signin_attempts, public.signin_lockouts
  from public, anon, authenticated, service_role;

grant select, insert on public.signin_attempts to app_server;
grant update (outcome) on public.signin_attempts to app_server;
grant select, insert on public.signin_lockouts to app_server;

alter table public.signin_attempts enable row level security;
alter table public.signin_lockouts enable row level security;

create policy signin_attempts_app_server on public.signin_attempts
  for all to app_server using (true) with check (true);
create policy signin_lockouts_app_server on public.signin_lockouts
  for all to app_server using (true) with check (true);
