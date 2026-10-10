import { serverEnv } from "@/lib/env/server";
import { reconciliationGuards } from "@/lib/reconciliation/command";
import { ballotGuards, ballotHooks } from "@/lib/votes/guards";
import { parseMasterKey } from "@/lib/votes/keys";
import { tallyHooks } from "@/lib/votes/tally";
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
    guards: { ...defaultGuards, ...ballotGuards, ...reconciliationGuards },
    hooks: [
      ...defaultHooks,
      ...ballotHooks,
      // After the booth is Closed (and force-close has cancelled pending sessions): its tally.
      ...tallyHooks(() => parseMasterKey(serverEnv().voteSigningMasterKey)),
    ],
  });
}
