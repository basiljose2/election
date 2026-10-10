"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useTerminalState } from "@/lib/signals/use-terminal-state";

interface VotingState {
  role: "voting";
  version: number;
  boothState: string;
  ballotPending: boolean;
}

/**
 * Placeholder Voting Terminal screen: the ballot itself is built by voting-terminal-ui. It
 * shows only what the server says (locked until a Ballot Session is pending) and never
 * trusts a signal on its own.
 */
export function VotingTerminalScreen() {
  const router = useRouter();
  const { state, mode, unpaired } = useTerminalState<VotingState>({ base: "/terminal/api" });

  useEffect(() => {
    if (unpaired) router.replace("/terminal/pair");
  }, [unpaired, router]);

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-6 p-8 text-center">
      {state?.ballotPending ? (
        <h1 className="text-4xl font-semibold" data-testid="terminal-unlocked">
          Ballot ready
        </h1>
      ) : (
        <h1 className="text-4xl font-semibold" data-testid="terminal-locked">
          Please wait
        </h1>
      )}
      <p className="text-sm text-zinc-500" data-testid="terminal-connection">
        {mode === "realtime" ? "Connected" : mode === "polling" ? "Reconnecting…" : "Connecting…"}
      </p>
    </main>
  );
}
