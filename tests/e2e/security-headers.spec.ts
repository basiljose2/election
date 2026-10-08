import { expect, test, type APIResponse } from "@playwright/test";

const ROUTES = [
  "/",
  "/sign-in",
  "/mfa",
  "/reauth",
  "/staff",
  "/admin/staff",
  "/api/audit/system/export",
  "/api/audit/not-a-chain/export",
  "/this-route-does-not-exist",
];

function expectBaselineHeaders(res: APIResponse) {
  const h = res.headers();
  expect(h["strict-transport-security"]).toContain("max-age=63072000");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["referrer-policy"]).toBe("no-referrer");
  expect(h["permissions-policy"]).toContain("camera=()");
  expect(h["cross-origin-opener-policy"]).toBe("same-origin");
  expect(h["x-powered-by"]).toBeUndefined();
}

test.describe("security headers", () => {
  for (const route of ROUTES) {
    test(`are present on ${route}`, async ({ request }) => {
      const res = await request.get(route, { maxRedirects: 0 });
      expectBaselineHeaders(res);
      const csp = res.headers()["content-security-policy"];
      expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).not.toContain("unsafe-inline");
      expect(csp).not.toContain("unsafe-eval");
    });
  }

  test("use a fresh nonce per request, matching the page's scripts", async ({ request }) => {
    const nonces = [];
    for (let i = 0; i < 2; i++) {
      const res = await request.get("/sign-in");
      const nonce = /'nonce-([^']+)'/.exec(res.headers()["content-security-policy"]!)?.[1];
      expect(nonce).toBeTruthy();
      const html = await res.text();
      const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
      expect(scripts.length).toBeGreaterThan(0);
      for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
      nonces.push(nonce);
    }
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  test("are present on static assets", async ({ request }) => {
    const html = await (await request.get("/sign-in")).text();
    const asset = /\/_next\/static\/[^"']+\.(?:js|css)/.exec(html)?.[0];
    expect(asset).toBeTruthy();
    for (const path of [asset!, "/favicon.ico"]) {
      const res = await request.get(path);
      expect(res.status()).toBe(200);
      expectBaselineHeaders(res);
      expect(res.headers()["content-security-policy"]).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
    }
  });

  test("the page loads without CSP violations", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (msg) => {
      if (/content security policy/i.test(msg.text())) violations.push(msg.text());
    });
    await page.goto("/sign-in");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await page.goto("/");
    await page.getByRole("link", { name: "Staff sign in" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    expect(violations).toEqual([]);
  });
});
