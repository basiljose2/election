import { randomUUID } from "node:crypto";
import {
  expect as baseExpect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { E2E_PASSWORD, loadUsers, signIn } from "./users";

/**
 * The Presiding Officer's Master Terminal against a real Polling Open election: pairing, the
 * ballot flow, cancel, mock poll, open, close and the idle lock. One booth moves forward through
 * its lifecycle, so the tests run in order and share their pages.
 */
test.describe.configure({ mode: "serial", timeout: 180_000 });

const expect = baseExpect.configure({ timeout: 15_000 });

const { master: fixture } = loadUsers();

let masterContext: BrowserContext;
let kioskContext: BrowserContext;
let master: Page;
let kiosk: Page;

/** Every request the Master Terminal page made, for the "no real counts" check. */
const requested: string[] = [];
/** Server action POSTs (they carry a Next-Action header). */
let serverActions = 0;

const boothState = (page: Page) => page.getByTestId("booth-state");
const dialog = (page: Page) => page.getByRole("dialog");

async function pairKiosk(browser: Browser) {
  masterContext = await browser.newContext();
  master = await masterContext.newPage();
  master.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/master")) requested.push(`${request.method()} ${url.pathname}`);
    if (request.method() === "POST" && request.headers()["next-action"]) serverActions += 1;
  });
  await signIn(master, fixture.presidingOfficer.email);
  await expect(master).toHaveURL(/\/staff$/);
  await master.goto("/master");
  await master.getByRole("button", { name: "Register this device as the Master Terminal" }).click();
  await expect(boothState(master)).toBeVisible();

  await master.getByRole("button", { name: "Generate pairing code" }).click();
  const code = (await master.getByTestId("pairing-code").textContent())!.trim();

  kioskContext = await browser.newContext();
  kiosk = await kioskContext.newPage();
  await kiosk.goto("/terminal/pair");
  await kiosk.getByLabel("Pairing code").fill(code);
  await kiosk.getByRole("button", { name: "Pair this device" }).click();
  await expect(master.getByTestId("pending-device-id")).toBeVisible();
  await master.getByRole("button", { name: "Confirm" }).click();
  // Left unactivated on purpose: it still sends heartbeats, but never fetches the ballot, so
  // the spec's own API casts cannot race the screen for the single-use cast token.
  await expect(kiosk.getByTestId("terminal-not-activated")).toBeVisible();
  await expect(master.getByTestId("voting-terminal-online")).toHaveText("online", {
    timeout: 30_000,
  });
}

/** The kiosk fetches its pending ballot and casts a vote for the given candidate. */
async function castFromKiosk(candidateIndex: number) {
  const ballot = await kiosk.request.get("/terminal/api/ballot");
  const pending = (await ballot.json()) as { status: string; castToken: string };
  expect(pending.status).toBe("pending");
  const cast = await kiosk.request.post("/terminal/api/cast", {
    data: {
      castToken: pending.castToken,
      idempotencyKey: randomUUID().replace(/-/g, ""),
      answers: [{ postId: fixture.postId, candidateIds: [fixture.candidateIds[candidateIndex]!] }],
    },
  });
  expect(cast.status()).toBe(200);
}

const ballotButton = () => master.getByRole("button", { name: "BALLOT", exact: true });

async function pressBallot() {
  await expect(ballotButton()).toBeEnabled();
  await ballotButton().click();
  await expect(master.getByTestId("lamp-busy")).toHaveAttribute("data-lit", "true");
}

async function reauthDialog(password = E2E_PASSWORD) {
  await dialog(master).getByLabel("Your password").fill(password);
}

test.beforeAll(async ({ browser }) => {
  await pairKiosk(browser);
});

test.afterAll(async () => {
  await Promise.all([masterContext?.close(), kioskContext?.close()]);
});

test("the dashboard needs a Presiding Officer session and a registered device", async ({
  browser,
}) => {
  // No session: sent to sign in.
  const anonymous = await browser.newContext();
  const page = await anonymous.newPage();
  await page.goto("/master");
  await expect(page).toHaveURL(/\/sign-in/);
  await anonymous.close();

  // A signed-in Presiding Officer on an unregistered device is offered registration only.
  const fresh = await browser.newContext();
  const unregistered = await fresh.newPage();
  await signIn(unregistered, fixture.presidingOfficer.email);
  await expect(unregistered).toHaveURL(/\/staff$/);
  await unregistered.goto("/master");
  await expect(
    unregistered.getByRole("button", { name: "Register this device as the Master Terminal" }),
  ).toBeVisible();
  await expect(unregistered.getByRole("button", { name: "BALLOT", exact: true })).toHaveCount(0);
  await fresh.close();

  // The registered device shows the dashboard.
  await expect(master.getByTestId("booth-name")).toHaveText("Master booth");
  await expect(master.getByTestId("election-name")).toContainText("E2E master election");
});

test("it shows the booth state, counts and the connection mode", async () => {
  await expect(boothState(master)).toHaveAttribute("data-state", "setup");
  await expect(master.getByTestId("master-connection")).toContainText("Real-time", {
    timeout: 30_000,
  });
  await expect(master.getByTestId("count-cast")).toHaveText("0");
  await expect(master.getByTestId("count-cancelled")).toHaveText("0");
  await expect(master.getByTestId("voting-terminal-heartbeat")).toContainText("s ago");

  // Ballot is disabled outside a mock poll or open poll, and says why.
  await expect(ballotButton()).toBeDisabled();
  await expect(master.getByTestId("ballot-reason")).toContainText("open or in a mock poll");
});

test("a mock poll is banner-marked, counted separately and enables the Ballot flow", async () => {
  await master.getByTestId("start-mock").click();
  await expect(boothState(master)).toHaveAttribute("data-state", "mock_poll");
  await expect(master.getByTestId("mock-banner")).toBeVisible();
  await expect(master.getByTestId("master-screen")).toHaveAttribute("data-mock", "true");
  await expect(master.getByText("Mock ballots cast")).toBeVisible();

  // The kiosk stops sending heartbeats: shown offline once 30 s have passed (plus a refresh),
  // and the Ballot button is disabled with the reason.
  await expect(ballotButton()).toBeEnabled();
  await kiosk.route("**/terminal/api/heartbeat", (route) => route.abort());
  await expect(master.getByTestId("voting-terminal-online")).toHaveText("offline", {
    timeout: 50_000,
  });
  await expect(ballotButton()).toBeDisabled();
  await expect(master.getByTestId("ballot-reason")).toHaveText("The Voting Terminal is offline");
  await expect(master.getByTestId("lamp-ready")).toHaveAttribute("data-lit", "false");
  await kiosk.unroute("**/terminal/api/heartbeat");
  await expect(master.getByTestId("voting-terminal-online")).toHaveText("online", {
    timeout: 30_000,
  });

  // Rapid double click: one Ballot Session request.
  await expect(ballotButton()).toBeEnabled();
  const before = serverActions;
  await ballotButton().dblclick();
  await expect(master.getByTestId("lamp-busy")).toHaveAttribute("data-lit", "true");
  await expect(master.getByTestId("lamp-ready")).toHaveAttribute("data-lit", "false");
  await expect(ballotButton()).toBeDisabled();
  expect(serverActions - before).toBe(1);

  // The voter casts: Busy goes off, the count goes up and Ready lights again within 2 seconds.
  await castFromKiosk(0);
  await expect(master.getByTestId("count-cast")).toHaveText("1", { timeout: 2_500 });
  await expect(master.getByTestId("lamp-busy")).toHaveAttribute("data-lit", "false");
  await expect(master.getByTestId("lamp-ready")).toHaveAttribute("data-lit", "true");
});

test("a pending ballot is cancelled with a reason", async () => {
  await pressBallot();
  await expect(master.getByTestId("close-poll")).toHaveCount(0);
  await master.getByTestId("cancel-ballot").click();

  const cancel = dialog(master);
  await expect(cancel.getByRole("button", { name: "Cancel ballot" })).toBeDisabled();
  await cancel.getByLabel("Voter left without voting").check();
  await cancel.getByRole("button", { name: "Cancel ballot" }).click();

  await expect(master.getByTestId("count-cancelled")).toHaveText("1");
  await expect(master.getByTestId("lamp-busy")).toHaveAttribute("data-lit", "false");
  await expect(master.getByTestId("lamp-ready")).toHaveAttribute("data-lit", "true");
});

test("the mock result is shown, and clearing needs a confirmation that shows the counts", async () => {
  await master.getByTestId("show-mock-result").click();
  await expect(master.getByTestId("mock-total")).toHaveText("1");
  await expect(dialog(master).getByRole("row", { name: /Master candidate 0\s+1/ })).toBeVisible();
  await dialog(master).getByRole("button", { name: "Close" }).click();

  await master.getByTestId("clear-mock").click();
  await expect(dialog(master).getByTestId("mock-total")).toHaveText("1");
  await dialog(master).getByRole("button", { name: "Confirm: clear mock poll" }).click();

  await expect(boothState(master)).toHaveAttribute("data-state", "mock_cleared");
  await expect(master.getByTestId("mock-banner")).toHaveCount(0);
  await expect(master.getByTestId("count-cast")).toHaveText("0");
});

test("the mock poll can be repeated before opening", async () => {
  await master.getByTestId("repeat-mock").click();
  await expect(boothState(master)).toHaveAttribute("data-state", "mock_poll");
  await expect(master.getByTestId("mock-banner")).toBeVisible();
  await expect(master.getByTestId("count-cast")).toHaveText("0");

  await pressBallot();
  await castFromKiosk(1);
  await expect(master.getByTestId("count-cast")).toHaveText("1", { timeout: 5_000 });

  await master.getByTestId("clear-mock").click();
  await dialog(master).getByRole("button", { name: "Confirm: clear mock poll" }).click();
  await expect(boothState(master)).toHaveAttribute("data-state", "mock_cleared");
});

test("opening the poll states the count is 0 and needs the password", async () => {
  await master.getByTestId("open-poll").click();
  await expect(dialog(master).getByTestId("open-count")).toHaveText("0");

  const confirm = dialog(master).getByRole("button", { name: "Confirm: open the poll" });
  await expect(confirm).toBeDisabled();

  await reauthDialog("not-the-password");
  await confirm.click();
  await expect(dialog(master).getByRole("alert")).toHaveText("Incorrect password.");
  await expect(boothState(master)).toHaveAttribute("data-state", "mock_cleared");

  await reauthDialog();
  await confirm.click();
  await expect(boothState(master)).toHaveAttribute("data-state", "open");
  await expect(master.getByTestId("mock-banner")).toHaveCount(0);
  await expect(master.getByText("Ballots cast", { exact: true })).toBeVisible();
  await expect(master.getByTestId("count-cast")).toHaveText("0");
});

test("while open, only totals are requested or shown: never per-candidate counts", async () => {
  await pressBallot();
  await castFromKiosk(2);
  await expect(master.getByTestId("count-cast")).toHaveText("1", { timeout: 5_000 });

  // A fresh load of the open booth, with every response of the master routes inspected.
  const bodies: string[] = [];
  const mockCountRequests: string[] = [];
  master.on("response", async (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/master")) return;
    if (url.pathname.endsWith("/mock-counts")) mockCountRequests.push(url.pathname);
    bodies.push(await response.text().catch(() => ""));
  });
  await master.reload();
  await expect(boothState(master)).toHaveAttribute("data-state", "open");
  await master.waitForTimeout(7_000); // two or more refresh cycles

  expect(mockCountRequests).toEqual([]);
  const everything = bodies.join("\n");
  for (const id of fixture.candidateIds) expect(everything).not.toContain(id);
  expect(everything).not.toContain("Master candidate");
  expect(await master.locator("main").innerText()).not.toContain("Master candidate");
});

test("an idle Master Terminal locks, keeps showing the state, and unlocks with the password", async () => {
  await master.clock.install();
  await master.reload();
  await expect(boothState(master)).toHaveAttribute("data-state", "open");
  await expect(ballotButton()).toBeEnabled();

  await master.clock.fastForward("05:10");
  const lock = master.getByTestId("lock-overlay");
  await expect(lock).toBeVisible();

  // State and counts stay visible; no action is possible.
  await expect(boothState(master)).toBeVisible();
  await expect(master.getByTestId("count-cast")).toHaveText("1");
  await expect(master.getByTestId("lamp-ready")).toBeVisible();
  await expect(ballotButton()).toBeDisabled();
  const before = serverActions;
  await ballotButton().click({ force: true });
  expect(serverActions).toBe(before);

  // A reload does not unlock it.
  await master.reload();
  await expect(master.getByTestId("lock-overlay")).toBeVisible();

  await lock.getByLabel("Presiding Officer password").fill("not-the-password");
  await lock.getByRole("button", { name: "Unlock" }).click();
  await expect(lock.getByRole("alert")).toHaveText("Incorrect password.");

  await lock.getByLabel("Presiding Officer password").fill(E2E_PASSWORD);
  await lock.getByRole("button", { name: "Unlock" }).click();
  await expect(master.getByTestId("lock-overlay")).toHaveCount(0);
  await expect(ballotButton()).toBeEnabled();
});

test("closing is blocked while a ballot is pending, and needs CLOSE and the password", async () => {
  await pressBallot();
  await expect(master.getByTestId("close-poll")).toBeDisabled();
  await expect(master.getByTestId("close-poll-reason")).toHaveText(
    "A ballot is pending: wait or cancel",
  );

  await master.getByTestId("cancel-ballot").click();
  await dialog(master).getByLabel("Terminal fault").check();
  await dialog(master).getByRole("button", { name: "Cancel ballot" }).click();
  await expect(master.getByTestId("close-poll")).toBeEnabled();

  await master.getByTestId("close-poll").click();
  const close = dialog(master);
  await expect(close.getByTestId("close-count-cast")).toHaveText("1");
  await expect(close.getByTestId("close-count-cancelled")).toHaveText("1");

  const confirm = close.getByRole("button", { name: "Confirm: close the poll" });
  await reauthDialog();
  await close.getByLabel("Type CLOSE to confirm").fill("close");
  await expect(confirm).toBeDisabled();
  await close.getByLabel("Type CLOSE to confirm").fill("CLOSE");
  await expect(confirm).toBeEnabled();
  await confirm.click();

  // A Closed booth rejects terminal credentials: the screen says so instead of offering controls.
  await expect(master.getByTestId("poll-closed")).toBeVisible();
  await expect(ballotButton()).toHaveCount(0);
  await master.reload();
  await expect(master.getByText("The poll at this booth is closed.")).toBeVisible();
});
