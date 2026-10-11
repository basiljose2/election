import { createPublicKey, verify } from "node:crypto";
import { expect as baseExpect, test } from "@playwright/test";
import { Pool } from "pg";
import { assertLocal } from "../support/local-only";
import { enrollTotp, loadUsers, signIn } from "./users";

/**
 * From a live polling dashboard to a declared, signed Result. Booth 1 was closed with seeded
 * signed votes by the global setup; booth 2 is Open. The Returning Officer force-closes booth 2
 * (whose counter we move without any vote, so its tally FAILS), completes the polls and
 * declares: the Posts of booth 1 are declared and booth 2's Post is withheld.
 */
test.describe.configure({ mode: "serial", timeout: 180_000 });

const expect = baseExpect.configure({ timeout: 15_000 });
const { results: fixture } = loadUsers();
const dashboardUrl = `/admin/elections/${fixture.electionId}/dashboard`;
const admin = new Pool({
  connectionString: assertLocal("TEST_ADMIN_DATABASE_URL", process.env.TEST_ADMIN_DATABASE_URL),
  max: 1,
});

test.afterAll(async () => {
  await admin.end();
});

test("dashboard, checklist, force-close, completion, declaration and exports", async ({ page }) => {
  // A ballot is pending at booth 2 whose Master Terminal is gone (a stand-in kiosk row).
  await admin.query(
    `with t as (
       insert into public.terminals (election_id, booth_id, type, status, credential_hash, revoked_at, revoked_reason)
       values ($1, $2, 'voting', 'revoked', encode(sha256(gen_random_uuid()::text::bytea), 'hex'), now(), 'fixture')
       returning id)
     insert into public.ballot_sessions (election_id, booth_id, terminal_id, is_mock, issued_by)
     select $1, $2, t.id, false, $3 from t`,
    [fixture.electionId, fixture.booth2Id, fixture.presidingOfficer2.userId],
  );

  await signIn(page, fixture.returningOfficer.email);
  await enrollTotp(page);
  await page.goto(dashboardUrl);

  // ---- Live booth table: totals and states only.
  await expect(page.getByTestId("dashboard-status")).toContainText("polling open");
  await expect(page.getByTestId("cast-" + fixture.boothId)).toHaveText("6");
  await expect(page.getByTestId("booth-row-" + fixture.boothId)).toContainText("Closed");
  await expect(page.getByTestId("booth-row-" + fixture.booth2Id)).toContainText("Open");
  await expect(page.getByTestId("total-cast")).toHaveText("6");
  expect(await page.content()).not.toMatch(/candidate [0-9]/i);

  // ---- Checklist: Complete all polls is blocked while booth 2 is Open.
  await expect(page.getByTestId("complete-polls")).toBeDisabled();
  await expect(page.getByTestId("complete-reason")).toBeVisible();
  const checklist = page.getByTestId("checklist");
  await expect(checklist).toContainText("Results booth 2");
  await expect(checklist).not.toContainText("Results booth 1");

  // ---- The pending ballot is cancelled by the Returning Officer, with a written reason.
  await expect(page.getByTestId("pending-ballots")).toContainText("Results booth 2");
  await page
    .getByLabel("Reason for cancelling the pending ballot at Results booth 2")
    .fill("Master Terminal failed");
  await page.getByRole("button", { name: "Cancel pending ballot at Results booth 2" }).click();
  await expect(page.getByText("Pending ballot cancelled")).toBeVisible();
  await expect(page.getByTestId("pending-ballots")).toHaveCount(0);

  // ---- A ballot is recorded at booth 2 (simulated at the counter): the table follows <= 10 s.
  await admin.query(
    "update public.booth_counters set ballots_cast = ballots_cast + 1 where booth_id = $1",
    [fixture.booth2Id],
  );
  await expect(page.getByTestId("cast-" + fixture.booth2Id)).toHaveText("1", { timeout: 10_000 });
  await expect(page.getByTestId("total-cast")).toHaveText("7", { timeout: 10_000 });

  // ---- Force-close booth 2 with a reason.
  await page.getByLabel("Reason for force-closing Results booth 2").fill("Power cut at the booth");
  await page.getByRole("button", { name: "Force close Results booth 2" }).click();
  await expect(page.getByText("Booth force-closed")).toBeVisible();
  await expect(page.getByTestId("booth-row-" + fixture.booth2Id)).toContainText("Closed");
  await expect(page.getByTestId("checklist-clear")).toBeVisible();

  // ---- Its tally FAILED (a ballot counted but no answers): the RO sees an alert.
  await page.goto(`/admin/elections/${fixture.electionId}`);
  await expect(page.getByTestId("failed-tally-alert")).toContainText("Results booth 2");
  await page.goto(dashboardUrl);

  // ---- Complete all polls.
  await expect(page.getByTestId("complete-polls")).toBeEnabled();
  await page.getByTestId("complete-polls").click();
  await expect(page.getByTestId("dashboard-status")).toContainText("polling completed");

  // ---- Declare.
  await page.getByTestId("declare-results").click();
  await expect(page).toHaveURL(/\/results$/);
  const results = page.getByTestId("results");
  await expect(results).toBeVisible();

  // Totals.
  await expect(page.getByTestId("tile-cast")).toHaveText("7");
  await expect(page.getByTestId("tile-booths")).toHaveText("2");

  const card = (name: string) => results.locator(`section[data-status]`, { hasText: name }).first();
  // President: c0 (2 votes) elected, NOTA (3) exceeded the winner, margin 1.
  const president = card("President");
  await expect(president).toHaveAttribute("data-status", "elected");
  await expect(president).toContainText("NOTA exceeded winner");
  await expect(president.getByTestId("margin")).toContainText("1");
  await expect(president.getByRole("list", { name: "Votes for President" })).toContainText(
    "President candidate 0",
  );
  // Council: two seats, candidates 0 and 1.
  await expect(card("Council")).toHaveAttribute("data-status", "elected");
  // Treasurer was withheld: no counts anywhere in its card.
  const treasurer = card("Treasurer");
  await expect(treasurer).toHaveAttribute("data-status", "withheld");
  await expect(treasurer.getByTestId("withheld-note")).toContainText("No counts are shown");
  expect(await treasurer.innerText()).not.toMatch(/\d+%/);

  // Booth-wise rows add up to the Post totals (President: 2 + 1 + 0 + NOTA 3 = 6 rows' votes).
  const rows = results.getByTestId("booth-wise").locator("tbody tr");
  let presidentSum = 0;
  for (const row of await rows.all()) {
    const cells = await row.locator("td").allInnerTexts();
    if (cells[1] === "President") presidentSum += Number(cells[3]);
  }
  expect(presidentSum).toBe(6);
  expect(await results.getByTestId("booth-wise").innerText()).not.toContain("Treasurer");

  // ---- Exports carry the Result hash; the JSON verifies with the published key.
  const hash = (await page.getByTestId("result-hash").textContent())!.trim();
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  const base = `/api/elections/${fixture.electionId}/results`;

  const envelope = (await (await page.request.get(`${base}/json`)).json()) as {
    result_hash: string;
    signature: string;
    public_key: string;
    canonical_json: string;
  };
  expect(envelope.result_hash).toBe(hash);
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: envelope.public_key },
    format: "jwk",
  });
  expect(
    verify(
      null,
      Buffer.from(envelope.canonical_json, "utf8"),
      key,
      Buffer.from(envelope.signature, "base64url"),
    ),
  ).toBe(true);

  const csv = await (await page.request.get(`${base}/csv`)).text();
  expect(csv.split(/\r?\n/)[1]).toContain(hash);
  // The withheld Post is listed by name only: its votes column is empty on every row.
  const treasurerRows = csv.split(/\r?\n/).filter((line) => line.includes(",Treasurer,"));
  expect(treasurerRows.length).toBeGreaterThan(0);
  for (const line of treasurerRows) expect(line.split(",")[8]).toBe("");

  const pdfResponse = await page.request.get(`${base}/pdf`);
  expect(pdfResponse.headers()["content-type"]).toBe("application/pdf");
  const pdf = (await pdfResponse.body()).toString("latin1");
  expect(pdf.startsWith("%PDF-")).toBe(true);
  expect(pdf).toContain(`Result hash: ${hash}`);
  expect(pdf).toContain("President");

  // ---- Declared once: the dashboard offers no second declaration.
  await page.goto(dashboardUrl);
  await expect(page.getByTestId("results-link")).toBeVisible();
  await expect(page.getByTestId("declare-results")).toHaveCount(0);
});
