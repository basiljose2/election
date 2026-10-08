import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appendAuditEvent } from "@/lib/audit/append";
import type { AuditTarget } from "@/lib/audit/chain";
import type { JsonValue } from "@/lib/audit/canonical-json";
import { CommandError } from "@/lib/commands/errors";
import type { AuthAdmin } from "@/lib/commands/staff";
import { getPool, withTransaction } from "@/lib/db/pool";
import type { Authenticator } from "./signin";
import { createSupabaseAdminClient } from "./supabase";

/** Reads the session id from an access token that was just issued to this server. */
function sessionIdOf(accessToken: string): string | null {
  const payload = accessToken.split(".")[1];
  if (!payload) return null;
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    session_id?: unknown;
  };
  return typeof claims.session_id === "string" ? claims.session_id : null;
}

export function supabaseAuthenticator(supabase: SupabaseClient): Authenticator {
  return {
    async signInWithPassword(email, password) {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error || !data.session || !data.user) return { ok: false };
      const sessionId = sessionIdOf(data.session.access_token);
      if (!sessionId) return { ok: false };
      return { ok: true, userId: data.user.id, sessionId };
    },
    async signOut() {
      await supabase.auth.signOut({ scope: "local" });
    },
  };
}

export function supabaseAuthAdmin(): AuthAdmin {
  const admin = createSupabaseAdminClient();
  return {
    async createUser(email, password) {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (error || !data.user) {
        if (error?.code === "email_exists") {
          throw new CommandError("conflict", "An account with this email already exists");
        }
        if (error?.code === "weak_password") {
          throw new CommandError("invalid_input", error.message);
        }
        throw new Error(`Supabase createUser failed: ${error?.message ?? "no user"}`);
      }
      return { userId: data.user.id };
    },
    async deleteUser(userId) {
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) throw new Error(`Supabase deleteUser failed: ${error.message}`);
    },
    async banUser(userId) {
      const { error } = await admin.auth.admin.updateUserById(userId, { ban_duration: "876000h" });
      if (error) throw new Error(`Supabase ban failed: ${error.message}`);
    },
  };
}

/** Audits an authentication step (MFA, sign-out) in its own transaction. */
export async function recordAuthEvent(event: {
  eventType: string;
  userId: string;
  target: AuditTarget;
  detail?: JsonValue;
}): Promise<void> {
  await withTransaction(getPool(), (tx) =>
    appendAuditEvent(tx, {
      electionId: null,
      eventType: event.eventType,
      actor: { user_id: event.userId, role: null, terminal_id: null },
      target: event.target,
      detail: event.detail ?? null,
    }),
  );
}
