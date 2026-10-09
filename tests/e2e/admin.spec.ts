import { expect, test } from "@playwright/test";
import { E2E_PASSWORD, enrollTotp, loadUsers, signIn } from "./users";

test.describe.configure({ timeout: 120_000 });

test("a Super Admin creates staff, assigns and revokes a role, and deactivates the account", async ({
  page,
  browser,
}) => {
  const { superAdmin, run, electionId, spareBoothId: boothId } = loadUsers();
  await signIn(page, superAdmin.email);
  await enrollTotp(page);

  await page.getByRole("link", { name: "Manage staff" }).click();
  await expect(page).toHaveURL(/\/admin\/staff$/);

  const email = `e2e-new-${run}@example.test`;
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Display name").fill("New Officer");
  await page.getByLabel("Initial password (min. 12 characters)").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("main").getByRole("status")).toHaveText("Staff account created");

  const card = page.getByTestId(`staff-${email}`);

  // A PO assignment without a booth is rejected by the scope rules.
  await card.getByLabel("Role").selectOption("presiding_officer");
  await card.getByLabel("Election ID").fill(electionId);
  await card.getByRole("button", { name: "Assign role" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Presiding Officers need an election and a booth",
  );

  await card.getByLabel("Role").selectOption("presiding_officer");
  await card.getByLabel("Election ID").fill(electionId);
  await card.getByLabel("Booth ID").fill(boothId);
  await card.getByRole("button", { name: "Assign role" }).click();
  await expect(page.getByRole("main").getByRole("status")).toHaveText("Role assigned");
  await expect(card.getByTestId("role-assignments")).toContainText(
    `Presiding Officer · election ${electionId} · booth ${boothId}`,
  );

  // The new officer can sign in while active.
  const officer = await browser.newPage();
  await signIn(officer, email);
  await expect(officer).toHaveURL(/\/staff$/);

  await card.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByRole("main").getByRole("status")).toHaveText("Role revoked");
  await expect(card.getByTestId("role-assignments")).toBeEmpty();

  await card.getByRole("button", { name: "Deactivate" }).click();
  await expect(page.getByRole("main").getByRole("status")).toHaveText("Account deactivated");
  await expect(card).toContainText("deactivated");

  // The existing session is invalidated and new sign-ins are rejected.
  await officer.goto("/staff");
  await expect(officer).toHaveURL(/\/sign-in$/);
  await signIn(officer, email);
  await expect(officer).toHaveURL(/\/sign-in\?error=invalid$/);
  await officer.close();
});
