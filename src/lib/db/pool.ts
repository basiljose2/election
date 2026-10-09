import "server-only";
import { Pool, type PoolClient } from "pg";
import { serverEnv } from "@/lib/env/server";
import { SUPABASE_ROOT_CA } from "./supabase-ca";

export type Db = Pool;
export type Tx = PoolClient;

const globalForPool = globalThis as unknown as { __campusEvmPool?: Pool };

/** Pool connected as `app_server`. Hosted environments use the transaction pooler. */
export function getPool(): Pool {
  globalForPool.__campusEvmPool ??= createPool(serverEnv().databaseUrl);
  return globalForPool.__campusEvmPool;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Local Postgres has no TLS. Hosted Supabase requires TLS with full certificate
 * verification against the Supabase root CA (sslmode in the URL is ignored so it cannot
 * weaken that).
 */
export function createPool(connectionString: string): Pool {
  const url = new URL(connectionString);
  const local = LOCAL_HOSTS.has(url.hostname);
  url.searchParams.delete("sslmode");
  return new Pool({
    connectionString: url.toString(),
    ssl: local ? false : { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true },
    max: 5,
    idleTimeoutMillis: 10_000,
  });
}

/** Runs `fn` in one database transaction; rolls back if it throws. */
export async function withTransaction<T>(db: Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
