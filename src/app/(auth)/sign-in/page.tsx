import type { Metadata } from "next";
import { Button, Field, first, Notice, PageShell } from "@/components/ui";
import { signInAction } from "../actions";

export const metadata: Metadata = { title: "Sign in · Campus EVM" };

const ERRORS: Record<string, string> = {
  invalid: "Incorrect email or password.",
  locked: "Too many failed attempts. Sign-in for this account is blocked for 15 minutes.",
};

const REASONS: Record<string, string> = {
  idle: "You were signed out after a period of inactivity.",
  signed_out: "You have signed out.",
};

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const params = await searchParams;
  const error = ERRORS[first(params.error) ?? ""];
  const reason = REASONS[first(params.reason) ?? ""];

  return (
    <PageShell title="Staff sign in">
      {error && <Notice tone="error">{error}</Notice>}
      {!error && reason && <Notice tone="info">{reason}</Notice>}
      <form action={signInAction} className="flex max-w-sm flex-col gap-4">
        <Field label="Email" name="email" type="email" autoComplete="username" required />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        <Button type="submit">Sign in</Button>
      </form>
    </PageShell>
  );
}
