import { ballotGuards, ballotHooks } from "@/lib/votes/guards";
import type { SignalPublisher } from "@/lib/signals/types";
import { createLifecycleCommands, defaultHooks, type LifecycleCommands } from "./engine";
import { defaultGuards } from "./guards";

/**
 * The lifecycle commands as the application runs them: the engine's own guards plus those
 * registered by the changes that own their data (ballot-casting-core). results-dashboard will
 * add `resultsReady`; until then declaring results fails closed.
 */
export function createAppLifecycle(publisher: SignalPublisher): LifecycleCommands {
  return createLifecycleCommands({
    publisher,
    guards: { ...defaultGuards, ...ballotGuards },
    hooks: [...defaultHooks, ...ballotHooks],
  });
}
