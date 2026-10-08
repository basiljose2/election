import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Button, Field, first, Notice, PageShell } from "@/components/ui";
import { getActorResolution } from "@/lib/auth/current-actor";
import { createSupabaseServerClient } from "@/lib/auth/supabase";
import { verifyMfaAction } from "../actions";
import { EnrollForm } from "./enroll-form";

export const metadata: Metadata = { title: "Two-factor authentication · Campus EVM" };

export default async function MfaPage({ searchParams }: PageProps<"/mfa">) {
  const resolution = await getActorResolution();
  if (resolution.status === "ok") redirect("/staff");
  if (resolution.status !== "mfa_required") redirect("/sign-in");

  const params = await searchParams;
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.mfa.listFactors();
  const factor = data?.totp[0];

  if (!factor) {
    return (
      <PageShell title="Set up two-factor authentication">
        <Notice tone="info">
          Your role requires an authenticator app. You must finish this step before you can use the
          system.
        </Notice>
        <EnrollForm />
      </PageShell>
    );
  }

  return (
    <PageShell title="Two-factor authentication">
      {first(params.error) === "invalid_code" && (
        <Notice tone="error">That code did not match. Wait for the next code and try again.</Notice>
      )}
      <form action={verifyMfaAction} className="flex max-w-sm flex-col gap-4">
        <input type="hidden" name="factorId" value={factor.id} />
        <Field
          label="Authentication code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          required
        />
        <Button type="submit">Verify</Button>
      </form>
    </PageShell>
  );
}
