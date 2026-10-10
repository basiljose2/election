import { describe, expect, it } from "vitest";
import type { Signal, SignalBus } from "@/lib/signals/types";

export interface ContractHarness {
  bus: SignalBus;
  /** A token that may subscribe to this booth's channel. */
  tokenFor(boothId: string): Promise<string> | string;
  /** Time to wait for a message that should NOT arrive. */
  quietMs?: number;
  close?(): Promise<void> | void;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeoutMs = 8000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await wait(25);
  }
}

/** The same behaviour is required of every SignalBus implementation. */
export function describeSignalBusContract(name: string, make: () => Promise<ContractHarness>) {
  describe(`SignalBus contract: ${name}`, () => {
    it("delivers a published signal to a subscriber of that booth only", async () => {
      const h = await make();
      const booth = crypto.randomUUID();
      const other = crypto.randomUUID();
      const got: Signal[] = [];
      const otherGot: Signal[] = [];
      let connected = false;
      const sub = h.bus.subscribe(
        { boothId: booth, token: await h.tokenFor(booth) },
        { onSignal: (s) => got.push(s), onStatus: (s) => (connected = s === "connected") },
      );
      const otherSub = h.bus.subscribe(
        { boothId: other, token: await h.tokenFor(other) },
        { onSignal: (s) => otherGot.push(s), onStatus: () => {} },
      );
      await until(() => connected);
      await wait(h.quietMs ?? 100);

      await h.bus.publish(booth, { type: "ballot-enabled", version: 7 });
      await until(() => got.length === 1);
      await wait(h.quietMs ?? 100);
      expect(got).toEqual([{ type: "ballot-enabled", version: 7 }]);
      expect(otherGot).toEqual([]);
      sub.unsubscribe();
      otherSub.unsubscribe();
      await h.close?.();
    });

    it("refuses a subscriber whose token is for another booth", async () => {
      const h = await make();
      const booth = crypto.randomUUID();
      const other = crypto.randomUUID();
      const got: Signal[] = [];
      const statuses: string[] = [];
      const sub = h.bus.subscribe(
        { boothId: booth, token: await h.tokenFor(other) }, // token for the wrong booth
        { onSignal: (s) => got.push(s), onStatus: (s) => statuses.push(s) },
      );
      await wait((h.quietMs ?? 100) + 500);
      await h.bus.publish(booth, { type: "ballot-cast", version: 1 });
      await wait(h.quietMs ?? 100);
      expect(got).toEqual([]);
      expect(statuses).not.toContain("connected");
      sub.unsubscribe();
      await h.close?.();
    });

    it("stops delivering after unsubscribe", async () => {
      const h = await make();
      const booth = crypto.randomUUID();
      const got: Signal[] = [];
      let connected = false;
      const sub = h.bus.subscribe(
        { boothId: booth, token: await h.tokenFor(booth) },
        { onSignal: (s) => got.push(s), onStatus: (s) => (connected = s === "connected") },
      );
      await until(() => connected);
      sub.unsubscribe();
      await wait(h.quietMs ?? 100);
      await h.bus.publish(booth, { type: "booth-state-changed", version: 2 });
      await wait(h.quietMs ?? 100);
      expect(got).toEqual([]);
      await h.close?.();
    });

    it("never publishes anything but {type, version}", async () => {
      const h = await make();
      const booth = crypto.randomUUID();
      for (const bad of [
        { type: "ballot-cast", version: 1, candidate: "x" },
        { type: "ballot-cast", version: 1, choices: ["a"] },
        { type: "not-a-signal", version: 1 },
        { type: "ballot-cast", version: -1 },
        { type: "ballot-cast", version: 1.5 },
      ]) {
        await expect(h.bus.publish(booth, bad as unknown as Signal)).rejects.toThrow();
      }
      await h.close?.();
    });
  });
}
