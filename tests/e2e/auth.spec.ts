import { expect, test } from "@playwright/test";
import { loadUsers, signIn, signOut } from "./users";

test.describe("staff sign-in and sign-out", () => {
  test("a Presiding Officer signs in and out with HttpOnly cookie sessions", async ({
    page,
    context,
  }) => {
    const { presidingOfficer, boothId } = loadUsers();

    await signIn(page, presidingOfficer.email);
    await expect(page).toHaveURL(/\/staff$/);
    await expect(page.getByRole("heading", { name: "Signed in as E2E PO" })).toBeVisible();
    await expect(page.getByTestId("roles")).toContainText(`Presiding Officer`);
    await expect(page.getByTestId("roles")).toContainText(boothId);

    const authCookies = (await context.cookies()).filter((c) => c.name.startsWith("sb-"));
    expect(authCookies.length).toBeGreaterThan(0);
    for (const cookie of authCookies) {
      expect(cookie.httpOnly).toBe(true);
      expect(cookie.secure).toBe(true);
      expect(cookie.sameSite).toBe("Strict");
    }
    // No script can read the session.
    expect(await page.evaluate(() => document.cookie)).not.toContain("sb-");

    await signOut(page);
    await page.goto("/staff");
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test("a wrong password is rejected", async ({ page }) => {
    const { presidingOfficer } = loadUsers();
    await signIn(page, presidingOfficer.email, "Not-The-Password-1");
    await expect(page).toHaveURL(/\/sign-in\?error=invalid$/);
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(
      "Incorrect email or password.",
    );
  });

  test("staff pages require a session", async ({ page }) => {
    await page.goto("/staff");
    await expect(page).toHaveURL(/\/sign-in$/);
    await page.goto("/admin/staff");
    await expect(page).toHaveURL(/\/sign-in$/);
  });
});
