import { describe, expect, it } from "vitest";
import { MemorySignalBus } from "@/lib/signals/memory";
import { parseSignal } from "@/lib/signals/types";
import { describeSignalBusContract } from "../support/signal-contract";

describeSignalBusContract("in-memory", async () => ({
  // A token is "<boothId>"; the in-memory authorizer accepts only a matching token.
  bus: new MemorySignalBus((boothId, token) => token === boothId),
  tokenFor: (boothId) => boothId,
  quietMs: 5,
}));

describe("parseSignal", () => {
  it("accepts exactly {type, version}", () => {
    expect(parseSignal({ type: "ballot-cast", version: 3 })).toEqual({
      type: "ballot-cast",
      version: 3,
    });
  });
  it("rejects extra fields, unknown types and bad versions", () => {
    for (const bad of [
      null,
      [],
      "x",
      { type: "ballot-cast" },
      { type: "ballot-cast", version: 1, nota: true },
      { type: "ballot-cast", version: 1, extra: 1 },
      { type: "weird", version: 1 },
      { type: "ballot-cast", version: "1" },
      { type: "ballot-cast", version: Number.MAX_SAFE_INTEGER + 2 },
    ]) {
      expect(parseSignal(bad)).toBeNull();
    }
  });
});

describe("MemorySignalBus outage", () => {
  it("reports disconnection and drops signals while down", async () => {
    const bus = new MemorySignalBus();
    const seen: string[] = [];
    bus.subscribe(
      { boothId: "b", token: "t" },
      { onSignal: (s) => seen.push(s.type), onStatus: (s) => seen.push(s) },
    );
    await Promise.resolve();
    bus.setConnected(false);
    await bus.publish("b", { type: "ballot-cast", version: 1 });
    bus.setConnected(true);
    expect(seen).toEqual(["connected", "disconnected", "connected"]);
  });
});
