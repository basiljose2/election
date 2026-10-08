-- Local development / CI only (runs on `supabase db reset`). Never used for hosted
-- environments, where app_server's password is set out of band (docs/ENVIRONMENTS.md).
alter role app_server with login password 'app_server_local_only';
