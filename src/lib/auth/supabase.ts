import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { serverEnv } from "@/lib/env/server";
import { AUTH_COOKIE_OPTIONS } from "./cookies";

/** Supabase Auth client bound to the request's HttpOnly session cookies. */
export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  const env = serverEnv();
  return createServerClient(env.supabaseUrl, env.supabasePublishableKey, {
    cookieOptions: AUTH_COOKIE_OPTIONS,
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) {
            cookieStore.set(name, value, { ...options, ...AUTH_COOKIE_OPTIONS });
          }
        } catch {
          // Server Components cannot set cookies; the proxy refreshes the session instead.
        }
      },
    },
  });
}

/** Auth admin API only (create/ban staff users). Never used for data access. */
export function createSupabaseAdminClient(): SupabaseClient {
  const env = serverEnv();
  return createClient(env.supabaseUrl, env.supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
