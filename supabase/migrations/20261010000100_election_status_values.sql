-- New Election states (election-state-machines). Added in their own migration: a new enum
-- value cannot be used until the transaction that adds it has committed.
alter type public.election_status add value if not exists 'polling_open';
alter type public.election_status add value if not exists 'polling_completed';
alter type public.election_status add value if not exists 'results_declared';
alter type public.election_status add value if not exists 'archived';
