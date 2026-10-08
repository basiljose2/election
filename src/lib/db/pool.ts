import "server-only";
import { Pool, type PoolClient } from "pg";
import { serverEnv } from "@/lib/env/server";

export type Db = Pool;
export type Tx = PoolClient;

const globalForPool = globalThis as unknown as { __campusEvmPool?: Pool };

/** Pool connected as `app_server`. Hosted environments use the transaction pooler. */
export function getPool(): Pool {
  globalForPool.__campusEvmPool ??= createPool(serverEnv().databaseUrl);
  return globalForPool.__campusEvmPool;
}

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString, max: 5, idleTimeoutMillis: 10_000 });
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
