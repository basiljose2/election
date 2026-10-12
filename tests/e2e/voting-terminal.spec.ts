import AxeBuilder from "@axe-core/playwright";
import {
  expect as baseExpect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { Pool } from "pg";
import { assertLocal } from "../support/local-only";
import { loadUsers, signIn } from "./users";

/**
 * The voter's Ballot Unit against a really-frozen election, driven by a real Master Terminal in
 * a mock poll (mock ballots use exactly the same screen and cast path as real ones). One booth,
 * so the tests run in order and share their pages.
 */
test.describe.configure({ mode: "serial", timeout: 180_000 });

const expect = baseExpect.configure({ timeout: 15_000 });
const { voting: fixture } = loadUsers();
const { president, council } = fixture;

let masterContext: BrowserContext;
let kioskContext: BrowserContext;
let master: Page;
let kiosk: Page;
const admin = new Pool({
  connectionString: assertLocal("TEST_ADMIN_DATABASE_URL", process.env.TEST_ADMIN_DATABASE_URL),
  max: 1,
});

/** Tones the kiosk asked the Web Audio API to play, recorded by an init script. */
const tones = () =>
  kiosk.evaluate(
    () => (window as unknown as { __tones: Array<{ frequency: number; seconds: number }> }).__tones,
  );

const ballotButton = () => master.getByRole("button", { name: "BALLOT", exact: true });
const CANDIDATE_NAME = /(President|Council) candidate \d/;

async function pairKiosk(browser: Browser) {
  masterContext = await browser.newContext();
  master = await masterContext.newPage();
  await signIn(master, fixture.presidingOfficer.email);
  await expect(master).toHaveURL(/\/staff$/);
  await master.goto("/master");
  await master.getByRole("button", { name: "Register this device as the Master Terminal" }).click();
  await expect(master.getByTestId("booth-state")).toBeVisible();
  await master.getByRole("button", { name: "Generate pairing code" }).click();
  const code = (await master.getByTestId("pairing-code").textContent())!.trim();

  kioskContext = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  await kioskContext.addInitScript(() => {
    const w = window as unknown as { __tones: Array<{ frequency: number; seconds: number }> };
    w.__tones = [];
    const start = OscillatorNode.prototype.start;
    const stop = OscillatorNode.prototype.stop;
    OscillatorNode.prototype.start = function (when?: number) {
      (this as unknown as { __at: number }).__at = when ?? 0;
      return start.call(this, when);
    };
    OscillatorNode.prototype.stop = function (when?: number) {
      const at = (this as unknown as { __at?: number }).__at ?? 0;
      w.__tones.push({ frequency: this.frequency.value, seconds: (when ?? 0) - at });
      return stop.call(this, when);
    };
  });
  kiosk = await kioskContext.newPage();
  await kiosk.goto("/terminal/pair");
  await kiosk.getByLabel("Pairing code").fill(code);
  await kiosk.getByRole("button", { name: "Pair this device" }).click();
  await expect(master.getByTestId("pending-device-id")).toBeVisible();
  await master.getByRole("button", { name: "Confirm" }).click();
  await expect(kiosk.getByTestId("terminal-not-activated")).toBeVisible();
  await expect(master.getByTestId("voting-terminal-online")).toHaveText("online", {
    timeout: 30_000,
  });
}

async function startMockPoll() {
  await master.getByTestId("start-mock").click();
  await expect(master.getByTestId("booth-state")).toHaveAttribute("data-state", "mock_poll");
}

async function pressBallot() {
  await expect(ballotButton()).toBeEnabled();
  await ballotButton().click();
}

const select = (id: string) => kiosk.getByTestId(`select-${id}`);
const lamp = (id: string) => kiosk.getByTestId(`lamp-${id}`);
const next = () => kiosk.getByTestId("next");
const hint = () => kiosk.getByTestId("post-hint");

const castSessions = async () =>
  Number(
    (
      await admin.query(
        "select count(*) n from public.ballot_sessions where booth_id = $1 and status = 'cast'",
        [fixture.boothId],
      )
    ).rows[0].n,
  );

test.beforeAll(async ({ browser }) => {
  await pairKiosk(browser);
});

test.afterAll(async () => {
  await admin.end();
  await Promise.all([masterContext?.close(), kioskContext?.close()]);
});

test("a ballot is not shown before activation; activating enters fullscreen and plays a tone", async () => {
  await startMockPoll();
  await pressBallot();
  await expect(master.getByTestId("lamp-busy")).toHaveAttribute("data-lit", "true");

  // Enabled on the server, but the terminal is not activated: nothing is shown.
  await kiosk.waitForTimeout(2_500);
  await expect(kiosk.getByTestId("terminal-not-activated")).toBeVisible();
  await expect(kiosk.getByText(CANDIDATE_NAME)).toHaveCount(0);

  await kiosk.getByRole("button", { name: "Activate" }).click();
  await expect(kiosk.getByTestId("terminal-unlocked")).toBeVisible();
  expect(await kiosk.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  expect(await tones()).toEqual([{ frequency: 880, seconds: expect.closeTo(0.3, 2) }]);
});

test("the first Post shows serials, names, symbols and lamps, with NOTA last", async () => {
  await expect(kiosk.getByTestId("post-progress")).toHaveText("Post 1 of 2");
  await expect(kiosk.getByTestId("post-instruction")).toHaveText("Select 1");
  await expect(kiosk.getByRole("heading", { name: "President" })).toBeVisible();

  const rows = kiosk.getByRole("listitem");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("President candidate 0");
  await expect(rows.nth(0)).toContainText("S00");
  await expect(rows.nth(2)).toContainText("President candidate 2");
  await expect(rows.nth(3)).toContainText("NOTA");
  await expect(next()).toBeDisabled();
});

test("selection rules: move, cap, NOTA exclusive, Next gating", async () => {
  const [p0, p1] = president.candidateIds;
  await select(p0!).click();
  await expect(lamp(p0!)).toHaveAttribute("data-lit", "true");
  await select(p1!).click(); // N = 1: moves the selection
  await expect(lamp(p0!)).toHaveAttribute("data-lit", "false");
  await expect(lamp(p1!)).toHaveAttribute("data-lit", "true");
  await expect(next()).toBeEnabled();
  await next().click();

  // Council has 2 seats.
  const [c0, c1, c2] = council.candidateIds;
  await expect(kiosk.getByTestId("post-instruction")).toHaveText("Select exactly 2");
  await select(c0!).click();
  await expect(hint()).toHaveText("Select 1 more");
  await expect(next()).toBeDisabled();
  await select(c1!).click();
  await expect(next()).toBeEnabled();

  await select(c2!).click(); // beyond N: refused
  await expect(hint()).toHaveText("You have already selected 2. Deselect one to change.");
  await expect(lamp(c2!)).toHaveAttribute("data-lit", "false");

  await select("nota").click(); // NOTA clears the Candidates
  await expect(lamp(c0!)).toHaveAttribute("data-lit", "false");
  await expect(lamp(c1!)).toHaveAttribute("data-lit", "false");
  await expect(lamp("nota")).toHaveAttribute("data-lit", "true");
  await expect(next()).toBeEnabled();

  await select(c2!).click(); // a Candidate clears NOTA
  await expect(lamp("nota")).toHaveAttribute("data-lit", "false");
  await expect(hint()).toHaveText("Select 1 more");
  await select(c0!).click();
  await expect(next()).toBeEnabled();
});

test("review lists every Post; Change returns to it and then straight back to review", async () => {
  await next().click();
  const [p0, p1] = president.candidateIds;
  await expect(kiosk.getByRole("heading", { name: "Review your choices" })).toBeVisible();
  await expect(kiosk.getByTestId(`review-${president.id}`)).toContainText("President candidate 1");
  await expect(kiosk.getByTestId(`review-${council.id}`)).toContainText("Council candidate 0");
  await expect(kiosk.getByTestId(`review-${council.id}`)).toContainText("Council candidate 2");

  await kiosk.getByRole("button", { name: "Change President" }).click();
  await expect(kiosk.getByRole("heading", { name: "President" })).toBeVisible();
  await expect(lamp(p1!)).toHaveAttribute("data-lit", "true"); // current selection kept
  await select(p0!).click();
  await next().click(); // back to review, not on to Council
  await expect(kiosk.getByTestId(`review-${president.id}`)).toContainText("President candidate 0");
  await expect(kiosk.getByTestId("cast")).toBeVisible();
});

test("a network drop while casting still records exactly one ballot, with one long beep", async () => {
  let attempts = 0;
  await kiosk.route("**/terminal/api/cast", (route) => {
    attempts += 1;
    return attempts <= 2 ? route.abort() : route.continue();
  });
  const before = await castSessions();

  await kiosk.getByTestId("cast").click();
  await expect(kiosk.getByTestId("terminal-casting")).toBeVisible();
  await expect(kiosk.getByText("Recording your vote…")).toBeVisible();
  await expect(kiosk.getByTestId("terminal-recorded")).toBeVisible({ timeout: 15_000 });
  await expect(kiosk.getByText("Your vote has been recorded")).toBeVisible();
  await expect(kiosk.getByTestId("terminal-locked")).toBeVisible({ timeout: 8_000 });
  await kiosk.unroute("**/terminal/api/cast");

  expect(attempts).toBe(3);
  expect(await castSessions()).toBe(before + 1);
  const rows = await admin.query(
    "select count(*) n from public.vote_selections where booth_id = $1 and is_mock",
    [fixture.boothId],
  );
  expect(Number(rows.rows[0].n)).toBe(3); // President 1 + Council 2

  // Exactly one ~2 s beep (after the activation test tone).
  const played = await tones();
  expect(played).toHaveLength(2);
  expect(played[1]).toEqual({ frequency: 1000, seconds: expect.closeTo(2, 1) });

  // Nothing of the ballot is left behind.
  await expect(kiosk.getByText(CANDIDATE_NAME)).toHaveCount(0);
  const leftovers = await kiosk.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    databases: (await indexedDB.databases()).length,
    html: document.body.innerHTML.includes("candidate"),
  }));
  expect(leftovers).toEqual({ local: 0, session: 0, databases: 0, html: false });
  await expect(master.getByTestId("count-cast")).toHaveText("1");
});

test("a new ballot unlocks the first Post within a second", async () => {
  await expect(ballotButton()).toBeEnabled();
  const started = Date.now();
  await ballotButton().click();
  await expect(kiosk.getByTestId("terminal-unlocked")).toBeVisible({ timeout: 1_500 });
  expect(Date.now() - started).toBeLessThan(1_500);
});

test("cancelling while the voter is on a Post discards choices, locks and does not beep", async () => {
  await select(president.candidateIds[1]!).click();
  await expect(lamp(president.candidateIds[1]!)).toHaveAttribute("data-lit", "true");
  const tonesBefore = (await tones()).length;

  await master.getByTestId("cancel-ballot").click();
  await master.getByRole("dialog").getByLabel("Voter left without voting").check();
  await master.getByRole("dialog").getByRole("button", { name: "Cancel ballot" }).click();

  await expect(kiosk.getByTestId("terminal-locked")).toBeVisible({ timeout: 5_000 });
  await expect(kiosk.getByTestId("terminal-notice")).toContainText("cancelled");
  await expect(kiosk.getByText(CANDIDATE_NAME)).toHaveCount(0);
  expect(await tones()).toHaveLength(tonesBefore);
  expect(await kiosk.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test("a keyboard-only voter can select, move between Posts, review and cast", async () => {
  await pressBallot();
  await expect(kiosk.getByTestId("terminal-unlocked")).toBeVisible();

  const [p0, p1] = president.candidateIds;
  await select(p0!).focus();
  await kiosk.keyboard.press("ArrowDown"); // arrow keys move between the buttons
  await expect(select(p1!)).toBeFocused();
  await kiosk.keyboard.press("Enter");
  await expect(lamp(p1!)).toHaveAttribute("data-lit", "true");
  await next().focus();
  await kiosk.keyboard.press("Enter");

  const [c0, c1] = council.candidateIds;
  await expect(kiosk.getByTestId("post-progress")).toHaveText("Post 2 of 2");
  await select(c0!).focus();
  await kiosk.keyboard.press("Space");
  await kiosk.keyboard.press("ArrowDown");
  await kiosk.keyboard.press("Enter");
  await expect(lamp(c1!)).toHaveAttribute("data-lit", "true");
  await next().focus();
  await kiosk.keyboard.press("Enter");

  const before = await castSessions();
  await kiosk.getByTestId("cast").focus();
  await kiosk.keyboard.press("Enter");
  await expect(kiosk.getByTestId("terminal-recorded")).toBeVisible({ timeout: 15_000 });
  await expect(kiosk.getByTestId("terminal-locked")).toBeVisible({ timeout: 8_000 });
  expect(await castSessions()).toBe(before + 1);
});

test("kiosk protections: no context menu, selection, zoom, back navigation or links", async () => {
  await pressBallot();
  await expect(kiosk.getByTestId("terminal-unlocked")).toBeVisible();

  const prevented = await kiosk.evaluate(() => {
    const fire = (event: Event) => {
      document.body.dispatchEvent(event);
      return event.defaultPrevented;
    };
    return {
      contextmenu: fire(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
      selectstart: fire(new Event("selectstart", { bubbles: true, cancelable: true })),
      ctrlWheel: fire(new WheelEvent("wheel", { ctrlKey: true, bubbles: true, cancelable: true })),
      ctrlPlus: fire(
        new KeyboardEvent("keydown", { key: "+", ctrlKey: true, bubbles: true, cancelable: true }),
      ),
    };
  });
  expect(prevented).toEqual({
    contextmenu: true,
    selectstart: true,
    ctrlWheel: true,
    ctrlPlus: true,
  });

  await kiosk.goBack();
  await expect(kiosk).toHaveURL(/\/terminal$/);
  await expect(kiosk.getByTestId("terminal-unlocked")).toBeVisible();
  await expect(kiosk.locator("a")).toHaveCount(0);
  expect(await kiosk.evaluate(() => getComputedStyle(document.body).userSelect)).not.toBe("text");
  expect(await kiosk.locator('meta[name="viewport"]').getAttribute("content")).toContain(
    "user-scalable=no",
  );
});

test("leaving fullscreen hides the ballot behind an overlay and keeps the choices", async () => {
  const id = president.candidateIds[2]!;
  await select(id).click();
  await expect(lamp(id)).toHaveAttribute("data-lit", "true");

  await kiosk.evaluate(() => document.exitFullscreen());
  const overlay = kiosk.getByTestId("fullscreen-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay.getByRole("button", { name: "Return to full screen" })).toBeVisible();

  await overlay.getByRole("button", { name: "Return to full screen" }).click();
  await expect(overlay).toHaveCount(0);
  await expect(lamp(id)).toHaveAttribute("data-lit", "true"); // kept in memory
});

test("contrast and touch targets meet the requirements on every screen", async () => {
  const audit = async (name: string) => {
    const results = await new AxeBuilder({ page: kiosk })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      // The kiosk deliberately disables pinch-zoom (the spec requires it); the touch targets and
      // text are sized for the fixed viewport instead.
      .disableRules(["meta-viewport"])
      .analyze();
    expect(
      results.violations.map((v) => `${name}: ${v.id} (${v.nodes.length})`),
      `${name} accessibility`,
    ).toEqual([]);
    for (const button of await kiosk.getByRole("button").all()) {
      if (!(await button.isVisible())) continue;
      const box = await button.boundingBox();
      expect(box!.height, `${name}: button height`).toBeGreaterThanOrEqual(64);
    }
  };

  await audit("post screen");
  // Candidate 2 is still selected from the previous test; move the selection.
  await select(president.candidateIds[0]!).click();
  await next().click();
  await select(council.candidateIds[0]!).click();
  await select(council.candidateIds[1]!).click();
  await audit("council screen");
  await next().click();
  await audit("review screen");

  // Cancel from the master to reach the locked screen.
  await master.getByTestId("cancel-ballot").click();
  await master.getByRole("dialog").getByLabel("Terminal fault").check();
  await master.getByRole("dialog").getByRole("button", { name: "Cancel ballot" }).click();
  await expect(kiosk.getByTestId("terminal-locked")).toBeVisible({ timeout: 5_000 });
  await audit("locked screen");
});

test("a cast that keeps failing says so, keeps retrying, and the officer can cancel it", async () => {
  await pressBallot();
  await expect(kiosk.getByTestId("terminal-unlocked")).toBeVisible();
  await select(president.candidateIds[0]!).click();
  await next().click();
  await select(council.candidateIds[0]!).click();
  await select(council.candidateIds[1]!).click();
  await next().click();

  // The server answers every cast with a 500 (for example a missing signing key).
  let attempts = 0;
  await kiosk.route("**/terminal/api/cast", (route) => {
    attempts += 1;
    return route.fulfill({ status: 500, json: { status: "error" } });
  });
  const before = await castSessions();
  await kiosk.getByTestId("cast").click();
  await expect(kiosk.getByTestId("terminal-casting")).toBeVisible();

  // After a while it asks the voter to stay and call the Presiding Officer; it keeps trying.
  await expect(kiosk.getByText(/taking longer than usual/)).toBeVisible({ timeout: 25_000 });
  await expect(kiosk.getByTestId("terminal-casting")).toBeVisible();
  expect(attempts).toBeGreaterThan(2);
  expect(await castSessions()).toBe(before);

  // The Presiding Officer sees the pending ballot and cancels it: the kiosk locks.
  await kiosk.unroute("**/terminal/api/cast");
  await master.getByTestId("cancel-ballot").click();
  await master.getByRole("dialog").getByLabel("Terminal fault").check();
  await master.getByRole("dialog").getByRole("button", { name: "Cancel ballot" }).click();
  await expect(kiosk.getByTestId("terminal-locked")).toBeVisible({ timeout: 15_000 });
  await expect(kiosk.getByTestId("terminal-notice")).toContainText("cancelled");
  expect(await castSessions()).toBe(before);
});

test("a reload while locked shows no ballot; the terminal must be activated again", async () => {
  await kiosk.reload();
  await expect(kiosk.getByTestId("terminal-not-activated")).toBeVisible();
  await kiosk.getByRole("button", { name: "Activate" }).click();
  await expect(kiosk.getByTestId("terminal-locked")).toBeVisible();
  await expect(kiosk.getByText(CANDIDATE_NAME)).toHaveCount(0);
});
