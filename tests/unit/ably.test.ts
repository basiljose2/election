import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ablyPublisher, ablyTokenRequest } from "@/lib/signals/ably";

const KEY = "appId.keyId:super-secret";

describe("Ably SignalBus (offline checks)", () => {
  it("publishes {type, version} to the booth channel with the API key", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 201 }));
    await ablyPublisher({ apiKey: KEY, fetchImpl: fetchImpl as unknown as typeof fetch }).publish(
      "booth-1",
      { type: "ballot-cast", version: 4 },
    );
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://rest.ably.io/channels/booth%3Abooth-1/messages");
    expect(JSON.parse(init.body as string)).toEqual({
      name: "signal",
      data: { type: "ballot-cast", version: 4 },
    });
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("appId.keyId:super-secret").toString("base64")}`,
    );
  });

  it("refuses to publish anything but a plain signal", async () => {
    const publisher = ablyPublisher({ apiKey: KEY, fetchImpl: vi.fn() as unknown as typeof fetch });
    await expect(
      publisher.publish("b", { type: "ballot-cast", version: 1, choice: "x" } as never),
    ).rejects.toThrow("invalid signal");
  });

  it("surfaces a failed publish", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 401 }));
    await expect(
      ablyPublisher({ apiKey: KEY, fetchImpl: fetchImpl as unknown as typeof fetch }).publish("b", {
        type: "ballot-cast",
        version: 1,
      }),
    ).rejects.toThrow("401");
  });

  it("signs a token request that allows only subscribing to one booth for 15 minutes", async () => {
    const at = new Date("2026-10-09T10:00:00Z");
    const { tokenRequest, expiresAt } = await ablyTokenRequest(
      KEY,
      { id: "t-1", boothId: "b-1" },
      at,
    );
    expect(tokenRequest).toMatchObject({
      keyName: "appId.keyId",
      ttl: 900_000,
      clientId: "t-1",
      capability: JSON.stringify({ "booth:b-1": ["subscribe"] }),
    });
    expect(expiresAt.getTime() - at.getTime()).toBe(900_000);
    const r = tokenRequest as Record<string, string | number>;
    const signText = [r.keyName, r.ttl, r.capability, r.clientId, r.timestamp, r.nonce]
      .map((p) => `${p}\n`)
      .join("");
    expect(r.mac).toBe(createHmac("sha256", "super-secret").update(signText).digest("base64"));
  });

  it("rejects a malformed API key", async () => {
    await expect(ablyTokenRequest("nokey", { id: "t", boothId: "b" }, new Date())).rejects.toThrow(
      "ABLY_API_KEY",
    );
  });
});
