import { randomUUID } from "node:crypto";
import { describe } from "vitest";
import { ablyPublisher, ablyTokenRequest } from "@/lib/signals/ably";
import { ablySubscriber } from "@/lib/signals/ably-client";
import { describeSignalBusContract } from "../support/signal-contract";

/**
 * The same contract as the Supabase and in-memory implementations, run against a real Ably
 * app. Needs a dedicated Ably TEST app key in ABLY_TEST_API_KEY; skipped otherwise.
 */
const apiKey = process.env.ABLY_TEST_API_KEY;

describe.skipIf(!apiKey)("Ably (live)", () => {
  // Created inside the harness: describe bodies still run when the suite is skipped.
  describeSignalBusContract("Ably", async () => ({
    bus: {
      publish: (boothId, signal) => ablyPublisher({ apiKey: apiKey! }).publish(boothId, signal),
      subscribe: (channel, handlers) => ablySubscriber().subscribe(channel, handlers),
    },
    tokenFor: async (boothId) =>
      JSON.stringify(
        (await ablyTokenRequest(apiKey!, { id: randomUUID(), boothId }, new Date())).tokenRequest,
      ),
    quietMs: 1500,
  }));
});
