const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Tests create and change data; they must never run against a hosted database. */
export function assertLocal(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is not set (put local values in .env.test.local)`);
  const host = new URL(value).hostname;
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`${name} points at ${host}; tests only run against the local Supabase stack`);
  }
  return value;
}
