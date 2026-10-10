"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, Notice } from "@/components/ui";

type Step =
  | { kind: "enter" }
  | { kind: "waiting"; deviceId: string }
  | { kind: "done" }
  | { kind: "failed"; message: string };

const MESSAGES: Record<string, string> = {
  invalid: "That code was not accepted. Check it and try again.",
  rate_limited: "Too many attempts. Wait a few minutes and try again.",
  unavailable: "This booth cannot accept a terminal right now.",
  rejected: "The Presiding Officer rejected this device.",
  expired: "The pairing request timed out. Ask for a new code.",
};

export function PairForm({ initialCode, booth }: { initialCode: string; booth: string }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: "enter" });
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (step.kind !== "waiting") return;
    const timer = setInterval(async () => {
      const response = await fetch("/terminal/api/pairing", { cache: "no-store" }).catch(
        () => null,
      );
      if (!response?.ok) return;
      const result = (await response.json()) as { status: string };
      if (result.status === "paired") {
        setStep({ kind: "done" });
        router.replace("/terminal");
      } else if (result.status !== "waiting") {
        setStep({
          kind: "failed",
          message: MESSAGES[result.status] ?? "Pairing did not complete.",
        });
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [step.kind, router]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await fetch("/terminal/api/pairing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, ...(booth ? { booth } : {}) }),
      });
      const result = (await response.json()) as { status: string; deviceId?: string };
      if (result.status === "pending" && result.deviceId) {
        setStep({ kind: "waiting", deviceId: result.deviceId });
      } else {
        setStep({ kind: "failed", message: MESSAGES[result.status] ?? "Pairing failed." });
      }
    } finally {
      setBusy(false);
    }
  }

  if (step.kind === "waiting") {
    return (
      <div className="flex flex-col gap-4" data-testid="pairing-waiting">
        <p>Waiting for the Presiding Officer to confirm this device.</p>
        <p className="text-sm">Device id</p>
        <p className="font-mono text-5xl tracking-widest" data-testid="device-id">
          {step.deviceId}
        </p>
      </div>
    );
  }
  if (step.kind === "done")
    return <Notice tone="info">Paired. Opening the Voting Terminal…</Notice>;

  return (
    <form onSubmit={submit} className="flex max-w-sm flex-col gap-4">
      {step.kind === "failed" && <Notice tone="error">{step.message}</Notice>}
      <label className="flex flex-col gap-1 text-sm font-medium">
        Pairing code
        <input
          name="code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          autoComplete="off"
          pattern="[0-9]{6}"
          required
          className="h-12 rounded-md border border-zinc-300 bg-transparent px-3 font-mono text-2xl tracking-widest dark:border-zinc-700"
        />
      </label>
      <Button type="submit" disabled={busy || code.length !== 6}>
        Pair this device
      </Button>
    </form>
  );
}
