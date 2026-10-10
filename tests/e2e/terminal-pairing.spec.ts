import { expect as baseExpect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { assertLocal } from "../support/local-only";
import { loadUsers, signIn } from "./users";

test.describe.configure({ mode: "serial", timeout: 120_000 });

const expect = baseExpect.configure({ timeout: 15_000 });

const admin = () =>
  new Pool({
    connectionString: assertLocal("TEST_ADMIN_DATABASE_URL", process.env.TEST_ADMIN_DATABASE_URL),
    max: 1,
  });

async function ready(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500); // let React hydrate before interacting
}

test("a Presiding Officer registers a Master Terminal and pairs a kiosk with a one-time code", async ({
  browser,
}) => {
  const { terminals } = loadUsers();

  // ---- Master Terminal: the Presiding Officer signs in and registers this device.
  const masterContext = await browser.newContext();
  const master = await masterContext.newPage();
  await signIn(master, terminals.presidingOfficer.email);
  await expect(master).toHaveURL(/\/staff$/);
  await master.getByRole("link", { name: "Master Terminal" }).click();
  await ready(master);
  await master.getByRole("button", { name: "Register this device as the Master Terminal" }).click();
  await expect(master.getByTestId("voting-terminal-status")).toContainText("not paired");
  await ready(master);

  // ---- Kiosk: an unauthenticated device, with no code yet, cannot get anywhere.
  const kioskContext = await browser.newContext();
  const kiosk = await kioskContext.newPage();
  await kiosk.goto("/terminal");
  await expect(kiosk).toHaveURL(/\/terminal\/pair$/);

  // A wrong code is rejected.
  await ready(kiosk);
  await kiosk.getByLabel("Pairing code").fill("000000");
  await kiosk.getByRole("button", { name: "Pair this device" }).click();
  await expect(kiosk.getByText("That code was not accepted")).toBeVisible();

  // ---- The Master Terminal shows a code (and a QR code); the kiosk enters it.
  await master.getByRole("button", { name: "Generate pairing code" }).click();
  const code = (await master.getByTestId("pairing-code").textContent())!.trim();
  expect(code).toMatch(/^\d{6}$/);
  await expect(master.getByRole("img", { name: /QR code/ })).toBeVisible();

  await kiosk.getByLabel("Pairing code").fill(code);
  await kiosk.getByRole("button", { name: "Pair this device" }).click();
  const deviceId = (await kiosk.getByTestId("device-id").textContent())!.trim();
  expect(deviceId).toMatch(/^[0-9A-F]{4}$/);

  // ---- The Presiding Officer sees the same device id and confirms.
  await expect(master.getByTestId("pending-device-id")).toHaveText(deviceId);
  await master.getByRole("button", { name: "Confirm" }).click();

  // ---- The kiosk becomes the booth's Voting Terminal and stays locked.
  await expect(kiosk).toHaveURL(/\/terminal$/);
  await expect(kiosk.getByTestId("terminal-locked")).toBeVisible();
  await expect(kiosk.getByTestId("terminal-connection")).toHaveText("Connected");

  // ---- Its heartbeat shows on the Master Terminal as online.
  await expect(master.getByTestId("voting-terminal-online")).toHaveText("online", {
    timeout: 30_000,
  });

  // ---- The kiosk credential does not work on master routes.
  const wrong = await kiosk.request.get("/master/api/state");
  expect(wrong.status()).toBe(401); // the cookie is scoped to /terminal and is not even sent
  expect((await kiosk.request.get("/terminal/api/state")).status()).toBe(200);

  // ---- Registering a new Master Terminal revokes the first one.
  const secondContext = await browser.newContext();
  const second = await secondContext.newPage();
  await signIn(second, terminals.presidingOfficer.email);
  await expect(second).toHaveURL(/\/staff$/);
  await second.goto("/master");
  await ready(second);
  await second.getByRole("button", { name: "Register this device as the Master Terminal" }).click();
  await expect(second.getByTestId("voting-terminal-status")).toBeVisible();
  await expect(master.getByText("no longer the Master Terminal")).toBeVisible();

  await Promise.all([masterContext.close(), kioskContext.close(), secondContext.close()]);
});

test("with real-time blocked, the Voting Terminal unlocks within 3 seconds by polling", async ({
  browser,
}) => {
  const { terminals } = loadUsers();
  const db = admin();

  // Pair a fresh kiosk through the UI first (real-time available).
  const masterContext = await browser.newContext();
  const master = await masterContext.newPage();
  await signIn(master, terminals.presidingOfficer.email);
  await expect(master).toHaveURL(/\/staff$/);
  await master.goto("/master");
  await ready(master);
  const needsRegistration = await master
    .getByRole("button", { name: "Register this device as the Master Terminal" })
    .isVisible();
  if (needsRegistration) {
    await master
      .getByRole("button", { name: "Register this device as the Master Terminal" })
      .click();
  }
  await expect(master.getByTestId("voting-terminal-status")).toBeVisible();
  await ready(master);
  await master.getByRole("button", { name: "Generate pairing code" }).click();
  const code = (await master.getByTestId("pairing-code").textContent())!.trim();

  const kioskContext = await browser.newContext();
  const kiosk = await kioskContext.newPage();
  await kiosk.goto("/terminal/pair");
  await ready(kiosk);
  await kiosk.getByLabel("Pairing code").fill(code);
  await kiosk.getByRole("button", { name: "Pair this device" }).click();
  await expect(master.getByTestId("pending-device-id")).toBeVisible();
  await master.getByRole("button", { name: "Confirm" }).click();
  await expect(kiosk.getByTestId("terminal-locked")).toBeVisible();

  // Now cut real-time for this kiosk: every WebSocket is closed immediately.
  await kiosk.routeWebSocket(/.*/, (ws) => void ws.close());
  await kiosk.reload();
  await expect(kiosk.getByTestId("terminal-connection")).toHaveText("Reconnecting…");
  await expect(kiosk.getByTestId("terminal-locked")).toBeVisible();
  await kiosk.waitForTimeout(500); // (the page never goes network-idle while polling)

  // A Ballot Session becomes pending (stand-in fixture for ballot-casting-core).
  await db.query(
    "create table if not exists public.ballot_sessions (booth_id uuid not null, status text not null, is_mock boolean not null default false)",
  );
  await db.query("grant select on public.ballot_sessions to app_server");
  try {
    const started = Date.now();
    await db.query("insert into public.ballot_sessions (booth_id, status) values ($1, 'pending')", [
      terminals.boothId,
    ]);
    await baseExpect(kiosk.getByTestId("terminal-unlocked")).toBeVisible({ timeout: 3_000 });
    expect(Date.now() - started).toBeLessThan(3_000);
  } finally {
    await db.query("drop table public.ballot_sessions");
    await db.end();
  }
  await Promise.all([masterContext.close(), kioskContext.close()]);
});
