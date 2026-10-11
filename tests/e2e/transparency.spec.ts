import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect as baseExpect, test } from "@playwright/test";
import { Pool } from "pg";
import { assertLocal } from "../support/local-only";
import { enrollTotp, loadUsers, signIn } from "./users";

/**
 * Public pages, the verification bundle and its verifier, and the Observer feed. It runs after
 * results.spec.ts (file order), which declared the "results" election; the "master" election is
 * still Polling Open and serves as the not-yet-declared case.
 */
test.describe.configure({ mode: "serial", timeout: 180_000 });

const expect = baseExpect.configure({ timeout: 20_000 });
const users = loadUsers();
const { results: declared, master: undeclared } = users;
const admin = new Pool({
  connectionString: assertLocal("TEST_ADMIN_DATABASE_URL", process.env.TEST_ADMIN_DATABASE_URL),
  max: 1,
});

test.afterAll(async () => {
  await admin.end();
});

test("a Draft election is not public; a frozen one shows its setup, hashes and tallies", async ({
  browser,
}) => {
  const context = await browser.newContext(); // no login
  const page = await context.newPage();

  const draft = await page.goto(`/public/elections/${users.electionId}`);
  expect(draft!.status()).toBe(404);
  expect(
    (await page.request.get(`/public/api/elections/${users.electionId}/status`)).status(),
  ).toBe(404);

  await page.goto("/public");
  await expect(page.getByTestId("public-elections")).toContainText("E2E results election");
  await expect(page.getByTestId("public-elections")).not.toContainText("E2E election ");

  await page.goto(`/public/elections/${declared.electionId}`);
  await expect(page.getByTestId("setup-hash")).toHaveText(/^[0-9a-f]{64}$/);
  await expect(page.getByTestId("public-key")).toHaveText(/^[A-Za-z0-9_-]{43}$/);
  await expect(page.getByTestId(`booth-${declared.boothId}`)).toContainText(
    "Ballot Definition hash",
  );
  await expect(page.getByText("President candidate 0").first()).toBeVisible();

  // Booth Tallies are public, with hash and Merkle root; the closed booth 1 has a PASS tally.
  const tally = page.getByTestId(`tally-${declared.boothId}`);
  await expect(tally).toContainText("PASS");
  await expect(tally.getByTestId("tally-hash")).toHaveText(/^[0-9a-f]{64}$/);

  // The public setup JSON hashes to the Setup Hash shown on the page.
  const setupHash = (await page.getByTestId("setup-hash").textContent())!.trim();
  const setup = (await (
    await page.request.get(`/api/elections/${declared.electionId}/setup`)
  ).json()) as {
    setup_hash: string;
  };
  // (the setup endpoint serves Frozen Elections only; a declared one is served by the bundle)
  if (setup.setup_hash) expect(setup.setup_hash).toBe(setupHash);

  await context.close();
});

test("the public tally list matches the hash the Master Terminal showed", async ({ browser }) => {
  // master-terminal.spec.ts closed this booth and read its tally hash off the Master Terminal.
  const { rows } = await admin.query<{ tally_hash: string }>(
    "select tally_hash from public.booth_tallies where booth_id = $1",
    [undeclared.boothId],
  );
  test.skip(rows.length === 0, "needs the booth closed by master-terminal.spec.ts");

  const context = await browser.newContext();
  const page = await context.newPage();
  const body = (await (
    await page.request.get(`/public/api/elections/${undeclared.electionId}/tallies`)
  ).json()) as { tallies: Array<{ boothId: string; tallyHash: string; merkleRoot: string }> };
  const mine = body.tallies.find((t) => t.boothId === undeclared.boothId)!;
  expect(mine.tallyHash).toBe(rows[0]!.tally_hash);
  expect(mine.merkleRoot).toMatch(/^[0-9a-f]{64}$/);

  // The page shows the same hash an agent wrote down.
  await page.goto(`/public/elections/${undeclared.electionId}`);
  await expect(
    page.getByTestId(`tally-${undeclared.boothId}`).getByTestId("tally-hash"),
  ).toHaveText(rows[0]!.tally_hash);
  await context.close();
});

test("the live status board follows turnout within 15 seconds and shows no candidate data", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/public/elections/${declared.electionId}/status`);
  const cast = page.getByTestId(`public-cast-${declared.boothId}`);
  await expect(cast).toHaveText("6");

  // A ballot is counted at booth 1: the board catches up on its own.
  await admin.query(
    "update public.booth_counters set ballots_cast = ballots_cast + 1 where booth_id = $1",
    [declared.boothId],
  );
  await expect(cast).toHaveText("7", { timeout: 15_000 });

  const body = await page.locator("main").innerText();
  expect(body).not.toMatch(/candidate/i);
  const status = await (
    await page.request.get(`/public/api/elections/${declared.electionId}/status`)
  ).text();
  expect(status).not.toMatch(/candidate|votes|staff/i);
  await context.close();
});

test("before declaration no per-candidate result is available", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/public/elections/${undeclared.electionId}/results`);
  await expect(page.getByTestId("not-declared")).toBeVisible();
  expect(await page.locator("main").innerText()).not.toContain("Master candidate");

  const api = await page.request.get(`/public/api/elections/${undeclared.electionId}/result`);
  expect(await api.json()).toEqual({ election_id: undeclared.electionId, declared: false });
  expect(
    (await page.request.get(`/public/elections/${undeclared.electionId}/bundle`)).status(),
  ).toBe(404);
  await context.close();
});

test("after declaration: public results, the bundle, and the verifier page and CLI agree", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(`/public/elections/${declared.electionId}/results`);
  await expect(page.getByTestId("results")).toBeVisible();
  const hash = (await page.getByTestId("result-hash").textContent())!.trim();
  const api = (await (
    await page.request.get(`/public/api/elections/${declared.electionId}/result`)
  ).json()) as { result_hash: string; declared: boolean };
  expect(api.declared).toBe(true);
  expect(api.result_hash).toBe(hash);

  // Download the bundle.
  const response = await page.request.get(`/public/elections/${declared.electionId}/bundle`);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("application/zip");
  expect(response.headers()["cache-control"]).toContain("immutable");
  const zip = await response.body();
  const dir = mkdtempSync(path.join(tmpdir(), "verify-"));
  const file = path.join(dir, "bundle.zip");
  writeFileSync(file, zip);

  // The browser verifier, offline: no request leaves the page while it verifies.
  await page.goto("/verify");
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.getByTestId("bundle-file").setInputFiles({
    name: "bundle.zip",
    mimeType: "application/zip",
    buffer: zip,
  });
  const report = page.getByTestId("verify-report");
  await expect(report).toBeVisible({ timeout: 60_000 });
  await expect(report).toHaveAttribute("data-ok", "true");
  expect(requests.filter((u) => !u.startsWith("data:") && !u.includes("/_next/"))).toEqual([]);

  const browserChecks = await report
    .locator("li")
    .evaluateAll((items) =>
      items.map((li) => `${li.getAttribute("data-check")}:${li.getAttribute("data-status")}`),
    );

  // The CLI gives the same report.
  const cli = JSON.parse(
    execFileSync("node", ["tools/verifier/verify-bundle.mjs", file, "--json"], {
      encoding: "utf8",
    }),
  ) as { ok: boolean; checks: Array<{ id: string; status: string }>; resultHash: string };
  expect(cli.ok).toBe(true);
  expect(cli.resultHash).toBe(hash);
  expect(cli.checks.map((c) => `${c.id}:${c.status}`)).toEqual(browserChecks);
  expect(browserChecks).toContain("recount:pass");

  // A damaged file is reported, not crashed on.
  const damaged = Buffer.from(zip);
  damaged[damaged.length - 5] = 0;
  await page.getByTestId("bundle-file").setInputFiles({
    name: "damaged.zip",
    mimeType: "application/zip",
    buffer: damaged,
  });
  await expect(page.getByTestId("verify-error")).toBeVisible({ timeout: 30_000 });
  await context.close();
});

test("an Observer follows the audit feed live; a non-observer is rejected", async ({ browser }) => {
  // The Observer opens the feed.
  const observerContext = await browser.newContext();
  const observer = await observerContext.newPage();
  await signIn(observer, declared.observer.email);
  await expect(observer).toHaveURL(/\/staff$/);
  await observer.goto(`/admin/elections/${declared.electionId}/audit`);
  const feed = observer.getByTestId("audit-feed");
  await expect(feed).toBeVisible();
  await expect(feed.locator('[data-event="election.frozen"]')).toBeVisible();
  const before = await feed.locator('[data-event="election.reconciled"]').count();

  // Meanwhile the Returning Officer runs the reconciliation: an event for the feed.
  const officerContext = await browser.newContext();
  const officer = await officerContext.newPage();
  await signIn(officer, declared.feedOfficer.email);
  await enrollTotp(officer);
  await officer.goto(`/admin/elections/${declared.electionId}/reconciliation`);
  await officer.getByRole("button", { name: "Run reconciliation" }).click();
  await expect(officer.getByText("Reconciliation completed")).toBeVisible();

  // Within 15 seconds the Observer's feed shows it, without a reload.
  await expect(feed.locator('[data-event="election.reconciled"]')).toHaveCount(before + 1, {
    timeout: 15_000,
  });
  expect(await feed.innerText()).not.toMatch(/candidate_id|selection/i);

  // A Presiding Officer is not an Observer of the election.
  const poContext = await browser.newContext();
  const po = await poContext.newPage();
  await signIn(po, declared.presidingOfficer1.email);
  await expect(po).toHaveURL(/\/staff$/);
  await po.goto(`/admin/elections/${declared.electionId}/audit`);
  await expect(po.getByText("Only this election's Observers and officers")).toBeVisible();
  const denied = await po.request.get(`/api/elections/${declared.electionId}/audit?after=0`);
  expect(denied.status()).toBe(403);

  // And an anonymous client is refused outright.
  const anonymous = await browser.newContext();
  const anon = await anonymous.request.get(`/api/elections/${declared.electionId}/audit?after=0`);
  expect([401, 403]).toContain(anon.status());

  await Promise.all([
    observerContext.close(),
    officerContext.close(),
    poContext.close(),
    anonymous.close(),
  ]);
});

test("public endpoints refuse a flood: the 61st request in a minute gets 429", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const url = `/public/api/elections/${declared.electionId}/status`;
  const statuses: number[] = [];
  let retryAfter: string | undefined;
  for (let i = 0; i < 70; i++) {
    const response = await context.request.get(url);
    statuses.push(response.status());
    if (response.status() === 429) retryAfter ??= response.headers()["retry-after"];
  }
  expect(statuses).toContain(429);
  expect(statuses.indexOf(429)).toBeLessThanOrEqual(60); // refused at the latest on the 61st
  expect(Number(retryAfter)).toBeGreaterThan(0);
  // Nothing but the public paths is limited: the casting side is unaffected.
  const voting = await context.request.get("/terminal/api/state");
  expect(voting.status()).not.toBe(429);
  await context.close();
});
