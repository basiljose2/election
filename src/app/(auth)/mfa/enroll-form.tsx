"use client";

import { useActionState } from "react";
import { Button, Field, Notice } from "@/components/ui";
import { enrollMfaAction, type EnrollState } from "../actions";

const initial: EnrollState = { step: "start" };

export function EnrollForm() {
  const [state, action, pending] = useActionState(enrollMfaAction, initial);

  if (state.step === "start") {
    return (
      <form action={action} className="flex flex-col gap-4">
        {state.error && <Notice tone="error">{state.error}</Notice>}
        <input type="hidden" name="intent" value="start" />
        <div>
          <Button type="submit" disabled={pending}>
            Set up authenticator app
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form action={action} className="flex max-w-sm flex-col gap-4">
      {state.error && <Notice tone="error">{state.error}</Notice>}
      <p className="text-sm">
        Scan this code with your authenticator app, then enter the 6-digit code.
      </p>
      {/* eslint-disable-next-line @next/next/no-img-element -- data: URL from Supabase */}
      <img
        src={state.qrCode}
        alt="TOTP QR code"
        width={180}
        height={180}
        className="bg-white p-2"
      />
      <p className="text-sm">
        Or enter this key manually: <code data-testid="totp-secret">{state.secret}</code>
      </p>
      <input type="hidden" name="intent" value="verify" />
      <input type="hidden" name="factorId" value={state.factorId} />
      <Field
        label="Authentication code"
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        required
      />
      <Button type="submit" disabled={pending}>
        Activate
      </Button>
    </form>
  );
}
