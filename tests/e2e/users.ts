import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { Secret, TOTP } from "otpauth";

export const E2E_PASSWORD = "E2e-Password-123";
export const USERS_FILE = path.resolve(__dirname, ".auth/users.json");

interface E2eUser {
  email: string;
  userId: string;
}

export interface E2eUsers {
  run: string;
  electionId: string;
  boothId: string;
  /** A second booth of `electionId`, free of Presiding Officers. */
  spareBoothId: string;
  /** Fixtures for the election-setup spec: an empty Draft election with its own staff. */
  setup: {
    electionId: string;
    superAdmin: E2eUser;
    returningOfficer: E2eUser;
    presidingOfficer1: E2eUser;
    presidingOfficer2: E2eUser;
  };
  /** A Frozen election with one booth and its Presiding Officer, for terminal pairing. */
  terminals: { electionId: string; boothId: string; presidingOfficer: E2eUser };
  superAdmin: E2eUser;
  returningOfficer: E2eUser;
  presidingOfficer: E2eUser;
}

export function loadUsers(): E2eUsers {
  return JSON.parse(readFileSync(USERS_FILE, "utf8")) as E2eUsers;
}

export async function signIn(page: Page, email: string, password = E2E_PASSWORD) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

const lastCounter = new Map<string, number>();

/** A TOTP code from a time step not used before (Supabase rejects reused codes). */
export async function freshTotp(secret: string): Promise<string> {
  const totp = new TOTP({
    secret: Secret.fromBase32(secret),
    digits: 6,
    period: 30,
    algorithm: "SHA1",
  });
  const used = lastCounter.get(secret);
  while (used !== undefined && totp.counter() <= used) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  lastCounter.set(secret, totp.counter());
  return totp.generate();
}

/** Completes TOTP enrolment on /mfa and returns the secret. */
export async function enrollTotp(page: Page): Promise<string> {
  await expect(page).toHaveURL(/\/mfa$/);
  await page.getByRole("button", { name: "Set up authenticator app" }).click();
  const secret = (await page.getByTestId("totp-secret").textContent())?.trim();
  if (!secret) throw new Error("TOTP secret not shown");
  await page.getByLabel("Authentication code").fill(await freshTotp(secret));
  await page.getByRole("button", { name: "Activate" }).click();
  await expect(page).toHaveURL(/\/staff$/);
  return secret;
}

export async function signOut(page: Page) {
  await page.goto("/staff");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in\?reason=signed_out$/);
}
