import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { Pool } from "pg";
import { assertLocal } from "../support/local-only";
import { E2E_PASSWORD, USERS_FILE, type E2eUsers } from "./users";

config({ path: ".env.test.local", quiet: true });
config({ path: ".env.local", quiet: true });

/** Creates fresh staff accounts for this run (local Supabase stack only). */
export default async function globalSetup() {
  const url = process.env.SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  const adminDb = process.env.TEST_ADMIN_DATABASE_URL;
  if (!url || !secret || !adminDb) {
    throw new Error("SUPABASE_URL, SUPABASE_SECRET_KEY and TEST_ADMIN_DATABASE_URL are required");
  }
  assertLocal("SUPABASE_URL", url);
  assertLocal("TEST_ADMIN_DATABASE_URL", adminDb);
  const auth = createClient(url, secret, { auth: { persistSession: false } }).auth.admin;
  const db = new Pool({ connectionString: adminDb, max: 1 });

  const run = Date.now().toString(36);
  const electionId = randomUUID();
  const boothId = randomUUID();

  async function staff(
    label: string,
    role: string,
    scope: { electionId?: string; boothId?: string },
  ) {
    const email = `e2e-${label}-${run}@example.test`;
    const { data, error } = await auth.createUser({
      email,
      password: E2E_PASSWORD,
      email_confirm: true,
    });
    if (error || !data.user) throw new Error(`createUser ${email}: ${error?.message}`);
    await db.query("insert into public.staff (user_id, email, display_name) values ($1, $2, $3)", [
      data.user.id,
      email,
      `E2E ${label.toUpperCase()}`,
    ]);
    await db.query(
      "insert into public.staff_roles (user_id, role, election_id, booth_id) values ($1, $2, $3, $4)",
      [data.user.id, role, scope.electionId ?? null, scope.boothId ?? null],
    );
    return { email, userId: data.user.id };
  }

  const users: E2eUsers = {
    run,
    electionId,
    boothId,
    superAdmin: await staff("sa", "super_admin", {}),
    returningOfficer: await staff("ro", "returning_officer", { electionId }),
    presidingOfficer: await staff("po", "presiding_officer", { electionId, boothId }),
  };
  await db.end();

  mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
