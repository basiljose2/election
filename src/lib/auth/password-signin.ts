import "server-only";
import { appendAuditEvent } from "@/lib/audit/append";
import { getPool } from "@/lib/db/pool";
import { supabaseAuthenticator } from "./adapters";
import { signInWithPassword } from "./signin";
import { createSupabaseServerClient } from "./supabase";

/**
 * The application's rate-limited password sign-in, wired to this request's cookies. Used for
 * sign-in itself and for re-authentication (which passes the session it replaces).
 */
export async function signInForRequest(
  email: string,
  password: string,
  previousSessionId?: string,
) {
  const supabase = await createSupabaseServerClient();
  return signInWithPassword(
    email,
    password,
    {
      db: getPool(),
      now: () => new Date(),
      authenticator: supabaseAuthenticator(supabase),
      appendAudit: appendAuditEvent,
    },
    { previousSessionId },
  );
}
