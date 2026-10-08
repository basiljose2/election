import type { Metadata } from "next";
import { Button, Field, first, Notice, PageShell } from "@/components/ui";
import { requireActorForPage } from "@/lib/auth/current-actor";
import { isPrivileged } from "@/lib/auth/roles";
import { reauthenticateAction } from "../actions";

export const metadata: Metadata = { title: "Confirm it's you · Campus EVM" };

const ERRORS: Record<string, string> = {
  invalid: "Incorrect password.",
  locked: "Too many failed attempts. Try again in 15 minutes.",
};

export default async function ReauthPage({ searchParams }: PageProps<"/reauth">) {
  const actor = await requireActorForPage();
  const params = await searchParams;
  const error = ERRORS[first(params.error) ?? ""];

  return (
    <PageShell title="Confirm it's you">
      <Notice tone="info">This action needs you to sign in again (valid for 5 minutes).</Notice>
      {error && <Notice tone="error">{error}</Notice>}
      <form action={reauthenticateAction} className="flex max-w-sm flex-col gap-4">
        <input type="hidden" name="next" value={first(params.next) ?? "/staff"} />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        {isPrivileged(actor) && (
          <Field
            label="Authentication code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            required
          />
        )}
        <Button type="submit">Confirm</Button>
      </form>
    </PageShell>
  );
}
