import "server-only";
import { z } from "zod";

/**
 * Server-only environment. Importing this module from a Client Component fails the
 * Next.js build (see `server-only`), so secrets can never reach a browser bundle.
 * There are deliberately no NEXT_PUBLIC_* variables: browsers never talk to Supabase.
 */

export type AppEnv = "local" | "preview" | "production";

const schema = z.object({
  DATABASE_URL: z.url(),
  SUPABASE_URL: z.url(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SECRET_KEY: z.string().min(1),
  VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
});

export interface ServerEnv {
  appEnv: AppEnv;
  databaseUrl: string;
  supabaseUrl: string;
  supabasePublishableKey: string;
  supabaseSecretKey: string;
}

export function resolveAppEnv(vercelEnv: string | undefined): AppEnv {
  if (vercelEnv === "production") return "production";
  if (vercelEnv === "preview") return "preview";
  return "local";
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))];
    throw new Error(`Invalid server environment: ${names.join(", ")}`);
  }
  const env = parsed.data;
  const appEnv = resolveAppEnv(env.VERCEL_ENV);
  const db = new URL(env.DATABASE_URL);
  const dbUser = decodeURIComponent(db.username);

  // Server code writes as `app_server` (the pooler form is `app_server.<project-ref>`),
  // never as the owner role, so grants and triggers always apply.
  if (dbUser !== "app_server" && !dbUser.startsWith("app_server.")) {
    throw new Error("DATABASE_URL must connect as the app_server role");
  }
  if (appEnv !== "local") {
    for (const [name, value] of [
      ["DATABASE_URL", env.DATABASE_URL],
      ["SUPABASE_URL", env.SUPABASE_URL],
    ] as const) {
      if (LOCAL_HOSTS.has(new URL(value).hostname)) {
        throw new Error(`${name} points at a local host in the ${appEnv} environment`);
      }
    }
  }

  return {
    appEnv,
    databaseUrl: env.DATABASE_URL,
    supabaseUrl: env.SUPABASE_URL,
    supabasePublishableKey: env.SUPABASE_PUBLISHABLE_KEY,
    supabaseSecretKey: env.SUPABASE_SECRET_KEY,
  };
}

let cached: ServerEnv | undefined;

/** Validated lazily so `next build` does not need runtime secrets. */
export function serverEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}
