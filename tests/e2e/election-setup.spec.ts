import { createHash } from "node:crypto";
import { expect as baseExpect, test, type Locator, type Page } from "@playwright/test";
import { enrollTotp, loadUsers, signIn } from "./users";

test.describe.configure({ mode: "serial", timeout: 180_000 });
// Server actions redirect back to the page; the first requests are slow while the server warms up.
test.use({ actionTimeout: 15_000 });

const expect = baseExpect.configure({ timeout: 15_000 });

const status = (page: Page) => page.getByRole("main").getByRole("status");
const alert = (page: Page) => page.getByRole("main").getByRole("alert");

/** Interacting before React hydrates can lose input, so wait for the page to settle. */
async function ready(page: Page) {
  await page.waitForLoadState("networkidle");
  // React resets a form's fields when its action finishes; let that happen before typing.
  await page.waitForTimeout(500);
}

/**
 * Clicks a submit button, waits for the server action's response and the redirect that
 * follows it, then checks the notice. (Messages repeat, so the URL alone cannot tell a
 * fresh result from the previous one.)
 */
async function submit(page: Page, button: Locator, message: string) {
  await Promise.all([page.waitForResponse((r) => r.request().method() === "POST"), button.click()]);
  await ready(page);
  await expect(status(page)).toHaveText(message);
}

async function addCandidate(page: Page, post: string, name: string) {
  const card = page.getByTestId(`post-${post}`);
  await card.getByLabel(`New candidate for ${post}`).fill(name);
  await submit(page, card.getByRole("button", { name: "Add candidate" }), "Candidate added");
}

test("a Returning Officer sets up an election, a Super Admin assigns officers, and the RO freezes and unfreezes it", async ({
  page,
  browser,
}) => {
  const { setup } = loadUsers();
  const url = `/admin/elections/${setup.electionId}`;

  // --------------------------------------------------------------- RO: build the setup
  await signIn(page, setup.returningOfficer.email);
  await enrollTotp(page);
  await page.getByRole("link", { name: "Elections" }).click();
  await page.getByRole("link", { name: /E2E setup election/ }).click();
  await expect(page).toHaveURL(new RegExp(`${url}$`));
  await expect(page.getByTestId("election-status")).toContainText("Draft");

  for (const [name, seats] of [
    ["President", "1"],
    ["Council", "2"],
  ] as const) {
    const form = page.getByRole("form", { name: "Add post" });
    await form.getByLabel("New post name").fill(name);
    await form.getByLabel("Seats").fill(seats);
    await submit(page, form.getByRole("button", { name: "Add post" }), "Post added");
  }

  for (const name of ["Asha", "Bilal", "Chen"]) await addCandidate(page, "President", name);
  for (const name of ["Dev", "Eli"]) await addCandidate(page, "Council", name);

  // A duplicate candidate name is rejected.
  const president = page.getByTestId("post-President");
  await president.getByLabel("New candidate for President").fill("asha");
  await president.getByRole("button", { name: "Add candidate" }).click();
  await expect(alert(page)).toContainText("already exists");

  // Drag Chen to the top; the order survives a reload.
  const items = page
    .getByTestId("post-President")
    .getByTestId("sortable-list")
    .getByTestId("sortable-item");
  await expect(items).toHaveText([/Asha/, /Bilal/, /Chen/]);
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST"),
    items.nth(2).dragTo(items.nth(0)),
  ]);
  await ready(page);
  await expect(status(page)).toHaveText("Candidate order saved");
  await page.reload();
  await ready(page);
  await expect(items).toHaveText([/Chen/, /Asha/, /Bilal/]);

  // Booths and the Booth-Post mapping matrix.
  for (const [name, location] of [
    ["Main Hall", "Block A"],
    ["CS Block", "Block C"],
  ] as const) {
    const form = page.getByRole("form", { name: "Add booth" });
    await form.getByLabel("New booth name").fill(name);
    await form.getByLabel("Location").fill(location);
    await submit(page, form.getByRole("button", { name: "Add booth" }), "Polling Booth added");
  }
  const main = page.getByTestId("booth-Main Hall");
  const cs = page.getByTestId("booth-CS Block");
  await main.getByLabel("President").check();
  await submit(
    page,
    main.getByRole("button", { name: "Save mapping" }),
    "Booth-Post mapping saved",
  );
  await page.reload();
  await ready(page);
  await expect(main.getByLabel("President")).toBeChecked();
  await cs.getByLabel("President").check();
  await cs.getByLabel("Council").check();
  await submit(page, cs.getByRole("button", { name: "Save mapping" }), "Booth-Post mapping saved");
  await page.reload();
  await ready(page);
  await expect(main.getByLabel("President")).toBeChecked();
  await expect(main.getByLabel("Council")).not.toBeChecked();
  await expect(cs.getByLabel("President")).toBeChecked();
  await expect(cs.getByLabel("Council")).toBeChecked();

  // Freeze is refused while the booths have no Presiding Officer; every booth is listed.
  await page.getByRole("button", { name: "Freeze setup" }).click();
  await expect(alert(page)).toContainText('Booth "Main Hall" has no Presiding Officer');
  await expect(alert(page)).toContainText('Booth "CS Block" has no Presiding Officer');

  const boothId = async (booth: ReturnType<Page["getByTestId"]>) =>
    ((await booth.getByText(/Booth ID/).textContent()) ?? "").match(
      /Booth ID ([0-9a-f-]{36})/,
    )![1]!;
  const mainId = await boothId(main);
  const csId = await boothId(cs);

  // ------------------------------------------- Super Admin: assign a PO to each booth
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await signIn(adminPage, setup.superAdmin.email);
  await enrollTotp(adminPage);
  await adminPage.goto("/admin/staff");
  for (const [po, id] of [
    [setup.presidingOfficer1, mainId],
    [setup.presidingOfficer2, csId],
  ] as const) {
    const card = adminPage.getByTestId(`staff-${po.email}`);
    await card.getByLabel("Role").selectOption("presiding_officer");
    await card.getByLabel("Election ID").fill(setup.electionId);
    await card.getByLabel("Booth ID").fill(id);
    await card.getByRole("button", { name: "Assign role" }).click();
    await expect(adminPage.getByRole("main").getByRole("status")).toHaveText("Role assigned");
  }
  await adminContext.close();

  // --------------------------------------------------------------------- RO: freeze
  await page.goto(url);
  await submit(page, page.getByRole("button", { name: "Freeze setup" }), "Setup frozen");
  await expect(page.getByTestId("election-status")).toContainText("Frozen");
  const hash = (await page.getByTestId("setup-hash").textContent())!.trim();
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  await expect(page.getByText("Uncontested posts: Council")).toBeVisible();

  // Editing is no longer offered, and the public setup verifies against the Setup Hash.
  await expect(page.getByRole("button", { name: "Add post" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add candidate" })).toHaveCount(0);
  await expect(page.getByTestId("post-President").getByTestId("sortable-list")).toHaveCount(0);

  const published = await (
    await page.request.get(`/api/elections/${setup.electionId}/setup`)
  ).json();
  expect(published.setup_hash).toBe(hash);
  expect(createHash("sha256").update(published.canonical_json, "utf8").digest("hex")).toBe(hash);

  // ------------------------------------------------------------------- RO: unfreeze
  await submit(page, page.getByRole("button", { name: "Unfreeze" }), "Setup returned to Draft");
  await expect(page.getByTestId("election-status")).toContainText("Draft");
  expect((await page.request.get(`/api/elections/${setup.electionId}/setup`)).status()).toBe(404);
});

test("a Returning Officer cannot open another election's setup", async ({ page }) => {
  const { setup, electionId } = loadUsers();
  await signIn(page, setup.returningOfficer.email);
  // The RO of the setup election has no role in the other election.
  await page.goto(`/admin/elections/${electionId}`);
  // Either the MFA step or the denial stops access; the other election's setup is never shown.
  await expect(page.getByTestId("election-status")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add post" })).toHaveCount(0);
});
