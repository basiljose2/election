import { expect, test } from "@playwright/test";
import { enrollTotp, freshTotp, loadUsers, signIn, signOut } from "./users";

test.describe.configure({ mode: "serial", timeout: 120_000 });

test.describe("mandatory MFA for a Returning Officer", () => {
  let secret: string;

  test("an RO who has not completed MFA is denied every RO function", async ({ page }) => {
    const { returningOfficer, electionId } = loadUsers();
    await signIn(page, returningOfficer.email);
    await expect(page).toHaveURL(/\/mfa$/);
    await expect(
      page.getByRole("heading", { name: "Set up two-factor authentication" }),
    ).toBeVisible();

    await page.goto("/staff");
    await expect(page).toHaveURL(/\/mfa$/);
    await page.goto("/admin/staff");
    await expect(page).toHaveURL(/\/mfa$/);

    const res = await page.request.get(`/api/audit/${electionId}/export`);
    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({ error: "mfa_required" });
  });

  test("the RO enrols TOTP and then has access", async ({ page }) => {
    const { returningOfficer, electionId } = loadUsers();
    await signIn(page, returningOfficer.email);
    secret = await enrollTotp(page);

    const res = await page.request.get(`/api/audit/${electionId}/export`);
    expect(res.status()).toBe(200);
    expect((await res.json()).format).toBe("campus-evm-audit-export/v1");

    // Another election's chain and the system chain stay out of reach.
    expect((await page.request.get("/api/audit/system/export")).status()).toBe(403);

    // An RO is not a Super Admin.
    await page.goto("/admin/staff");
    await expect(page.getByRole("heading", { name: "Not authorized" })).toBeVisible();
    await signOut(page);
  });

  test("every later sign-in requires the TOTP challenge", async ({ page }) => {
    const { returningOfficer } = loadUsers();
    await signIn(page, returningOfficer.email);
    await expect(page).toHaveURL(/\/mfa$/);
    await expect(page.getByRole("heading", { name: "Two-factor authentication" })).toBeVisible();

    await page.getByLabel("Authentication code").fill("000000");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page).toHaveURL(/\/mfa\?error=invalid_code$/);
    await page.goto("/staff");
    await expect(page).toHaveURL(/\/mfa$/);

    await page.getByLabel("Authentication code").fill(await freshTotp(secret));
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page).toHaveURL(/\/staff$/);
    await expect(page.getByTestId("roles")).toContainText("Returning Officer");
  });
});
