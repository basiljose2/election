import { expect as baseExpect, test } from "@playwright/test";
import { Pool } from "pg";
import { assertLocal } from "../support/local-only";
import { enrollTotp, loadUsers, signIn } from "./users";

/**
 * The election reconciliation report, on the election whose booth master-terminal.spec.ts
 * closed (it must run first, which file order gives): the Returning Officer runs it, an
 * Observer reads it, and tampering after close turns the booth and its Posts FAILED.
 */
test.describe.configure({ mode: "serial", timeout: 120_000 });

const expect = baseExpect.configure({ timeout: 15_000 });
const { master: fixture } = loadUsers();
const reportUrl = `/admin/elections/${fixture.electionId}/reconciliation`;

const admin = new Pool({
  connectionString: assertLocal("TEST_ADMIN_DATABASE_URL", process.env.TEST_ADMIN_DATABASE_URL),
  max: 1,
});

test.beforeAll(async () => {
  const { rows } = await admin.query<{ state: string }>(
    "select state::text as state from public.booth_states where booth_id = $1",
    [fixture.boothId],
  );
  test.skip(rows[0]?.state !== "closed", "needs the booth closed by master-terminal.spec.ts");
});

test.afterAll(async () => {
  await admin.end();
});

test("the Returning Officer runs the reconciliation; it passes, shows totals only, and catches tampering", async ({
  page,
}) => {
  await signIn(page, fixture.returningOfficer.email);
  await enrollTotp(page);
  await page.goto(reportUrl);
  await expect(page.getByText("The election has not been reconciled yet.")).toBeVisible();

  await page.getByRole("button", { name: "Run reconciliation" }).click();
  await expect(page.getByText("Reconciliation completed")).toBeVisible();

  const report = page.getByTestId("reconciliation-report");
  await expect(report).toBeVisible();
  for (const check of await page.getByTestId("election-checks").locator("li").all()) {
    await expect(check).toHaveAttribute("data-passed", "true");
  }
  const booth = page.getByTestId(`booth-${fixture.boothId}`);
  await expect(booth).toContainText("Ballots cast 1 · cancelled 1");
  await expect(booth).toContainText("President: 1 ballot answers");
  await expect(booth.getByText(/^[0-9a-f]{64}$/)).toBeVisible();
  await expect(page.getByTestId("post-outcomes").locator("li").first()).toHaveAttribute(
    "data-status",
    "pass",
  );

  // No candidate names or ids anywhere on the page.
  const text = await page.locator("main").innerText();
  expect(text).not.toContain("Master candidate");
  for (const id of fixture.candidateIds) expect(await page.content()).not.toContain(id);

  // Tampering after close: a Vote Selection is added to the closed booth's store.
  await admin.query(
    `insert into public.vote_selections (election_id, booth_id, post_id, candidate_id, signature)
     values ($1, $2, $3, $4, $5)`,
    [fixture.electionId, fixture.boothId, fixture.postId, fixture.candidateIds[0], "B".repeat(86)],
  );
  await page.getByRole("button", { name: "Run reconciliation" }).click();
  await expect(page.getByText("Reconciliation completed")).toBeVisible();

  const failed = page.getByTestId(`booth-${fixture.boothId}`);
  await expect(failed.locator('[data-check="count_and_root_match"]')).toHaveAttribute(
    "data-passed",
    "false",
  );
  await expect(failed.locator('[data-check="selection_signatures"]')).toHaveAttribute(
    "data-passed",
    "false",
  );
  await expect(page.getByTestId("post-outcomes").locator("li").first()).toHaveAttribute(
    "data-status",
    "failed",
  );
});

test("an Observer sees the report, with the failure, but cannot run it", async ({ page }) => {
  await signIn(page, fixture.observer.email);
  await expect(page).toHaveURL(/\/staff$/);
  await page.goto(reportUrl);

  await expect(page.getByTestId("reconciliation-report")).toBeVisible();
  const booth = page.getByTestId(`booth-${fixture.boothId}`);
  await expect(booth).toContainText("Ballots cast 1");
  await expect(booth.locator('[data-check="count_and_root_match"]')).toHaveAttribute(
    "data-passed",
    "false",
  );
  await expect(page.getByRole("button", { name: "Run reconciliation" })).toHaveCount(0);
  expect(await page.locator("main").innerText()).not.toContain("Master candidate");
});
