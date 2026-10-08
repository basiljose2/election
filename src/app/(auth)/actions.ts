"use server";

import { redirect } from "next/navigation";
import { appendAuditEvent } from "@/lib/audit/append";
import { recordAuthEvent, supabaseAuthenticator } from "@/lib/auth/adapters";
import { getActorResolution } from "@/lib/auth/current-actor";
import { isPrivileged } from "@/lib/auth/roles";
import { signInWithPassword } from "@/lib/auth/signin";
import { createSupabaseServerClient } from "@/lib/auth/supabase";
import { getPool } from "@/lib/db/pool";

/** Only same-site relative paths are accepted as post-auth destinations. */
function safeNext(value: FormDataEntryValue | null): string {
  const next = typeof value === "string" ? value : "";
  return next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\")
    ? next
    : "/staff";
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

async function signIn(email: string, password: string, previousSessionId?: string) {
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

export async function signInAction(formData: FormData): Promise<void> {
  const result = await signIn(field(formData, "email"), field(formData, "password"));
  if (result.status === "locked") redirect("/sign-in?error=locked");
  if (result.status !== "ok") redirect("/sign-in?error=invalid");
  // /staff sends privileged roles on to MFA enrolment or challenge.
  redirect(safeNext(formData.get("next")));
}

export async function signOutAction(): Promise<void> {
  const resolution = await getActorResolution();
  const supabase = await createSupabaseServerClient();
  if (resolution.status === "ok" || resolution.status === "mfa_required") {
    const { actor } = resolution;
    await getPool().query(
      `update public.staff_sessions set ended_at = now(), end_reason = 'signed_out'
        where session_id = $1 and ended_at is null`,
      [actor.sessionId],
    );
    await recordAuthEvent({
      eventType: "auth.signed_out",
      userId: actor.userId,
      target: { type: "staff_session", id: actor.sessionId },
    });
  }
  await supabase.auth.signOut({ scope: "local" });
  redirect("/sign-in?reason=signed_out");
}

/** TOTP challenge for an already-enrolled factor. */
export async function verifyMfaAction(formData: FormData): Promise<void> {
  const resolution = await getActorResolution();
  if (resolution.status !== "mfa_required" && resolution.status !== "ok") redirect("/sign-in");
  const supabase = await createSupabaseServerClient();
  const factorId = field(formData, "factorId");
  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId,
    code: field(formData, "code").trim(),
  });
  if (error) redirect("/mfa?error=invalid_code");
  await recordAuthEvent({
    eventType: "auth.mfa_verified",
    userId: resolution.actor.userId,
    target: { type: "mfa_factor", id: factorId },
  });
  redirect(safeNext(formData.get("next")));
}

export interface EnrollState {
  step: "start" | "verify";
  factorId?: string;
  qrCode?: string;
  secret?: string;
  error?: string;
}

/** TOTP enrolment: "start" creates a factor and shows its secret; "verify" activates it. */
export async function enrollMfaAction(
  _prev: EnrollState,
  formData: FormData,
): Promise<EnrollState> {
  const resolution = await getActorResolution();
  if (resolution.status !== "mfa_required" && resolution.status !== "ok") redirect("/sign-in");
  const supabase = await createSupabaseServerClient();

  if (field(formData, "intent") === "start") {
    const factors = await supabase.auth.mfa.listFactors();
    if (factors.data?.totp.length) redirect("/mfa");
    // Remove abandoned, unverified enrolments before starting a new one.
    for (const factor of factors.data?.all ?? []) {
      if (factor.status === "unverified") await supabase.auth.mfa.unenroll({ factorId: factor.id });
    }
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `Campus EVM ${new Date().toISOString()}`,
    });
    if (error || !data) return { step: "start", error: "Could not start enrolment. Try again." };
    return {
      step: "verify",
      factorId: data.id,
      qrCode: data.totp.qr_code,
      secret: data.totp.secret,
    };
  }

  const factorId = field(formData, "factorId");
  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId,
    code: field(formData, "code").trim(),
  });
  if (error) {
    return { ..._prev, step: "verify", error: "That code did not match. Try the next one." };
  }
  await recordAuthEvent({
    eventType: "auth.mfa_enrolled",
    userId: resolution.actor.userId,
    target: { type: "mfa_factor", id: factorId },
  });
  redirect("/staff");
}

/** Re-authentication for critical actions: password, plus TOTP for privileged roles. */
export async function reauthenticateAction(formData: FormData): Promise<void> {
  const resolution = await getActorResolution();
  if (resolution.status !== "ok") redirect("/sign-in");
  const { actor } = resolution;
  const next = safeNext(formData.get("next"));
  const back = `/reauth?next=${encodeURIComponent(next)}`;

  const result = await signIn(actor.email, field(formData, "password"), actor.sessionId);
  if (result.status === "locked") redirect(`${back}&error=locked`);
  if (result.status !== "ok") redirect(`${back}&error=invalid`);

  if (isPrivileged(actor)) {
    const supabase = await createSupabaseServerClient();
    const factors = await supabase.auth.mfa.listFactors();
    const factor = factors.data?.totp[0];
    const verified =
      factor &&
      !(
        await supabase.auth.mfa.challengeAndVerify({
          factorId: factor.id,
          code: field(formData, "code").trim(),
        })
      ).error;
    // The new session stays at aal1 until the code is verified, so /mfa will ask again.
    if (!verified) redirect("/mfa?error=invalid_code");
    await recordAuthEvent({
      eventType: "auth.mfa_verified",
      userId: actor.userId,
      target: { type: "mfa_factor", id: factor.id },
      detail: { reauthentication: true },
    });
  }
  redirect(next);
}
