/**
 * Creates the first Super Admin. Refuses to run if an active Super Admin already exists;
 * after that, staff are managed in the app (/admin/staff).
 *
 *   BOOTSTRAP_EMAIL=... BOOTSTRAP_NAME="..." BOOTSTRAP_PASSWORD=... npm run bootstrap:admin
 *
 * Uses the same server-only env as the app (DATABASE_URL as app_server, Supabase secret key
 * for the Auth admin API) and records a system Audit Event.
 */
import { config } from "dotenv";
import { appendAuditEvent, SYSTEM_ACTOR } from "@/lib/audit/append";
import { createPool, withTransaction } from "@/lib/db/pool";
import { supabaseAuthAdmin } from "@/lib/auth/adapters";

config({ path: ".env.local", quiet: true });

async function main() {
  const email = process.env.BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const name = process.env.BOOTSTRAP_NAME?.trim();
  const password = process.env.BOOTSTRAP_PASSWORD;
  if (!email || !name || !password || password.length < 12) {
    throw new Error("Set BOOTSTRAP_EMAIL, BOOTSTRAP_NAME and BOOTSTRAP_PASSWORD (12+ characters)");
  }

  const { serverEnv } = await import("@/lib/env/server");
  const db = createPool(serverEnv().databaseUrl);
  const authAdmin = supabaseAuthAdmin();

  try {
    const existing = await db.query(
      `select 1 from public.staff_roles r join public.staff s using (user_id)
        where r.role = 'super_admin' and r.revoked_at is null and s.active`,
    );
    if (existing.rowCount) throw new Error("An active Super Admin already exists");

    const { userId } = await authAdmin.createUser(email, password);
    try {
      await withTransaction(db, async (tx) => {
        await tx.query(
          "insert into public.staff (user_id, email, display_name) values ($1, $2, $3)",
          [userId, email, name],
        );
        const role = await tx.query<{ id: string }>(
          "insert into public.staff_roles (user_id, role) values ($1, 'super_admin') returning id",
          [userId],
        );
        await appendAuditEvent(tx, {
          electionId: null,
          eventType: "staff.bootstrap_super_admin",
          actor: SYSTEM_ACTOR,
          target: { type: "staff", id: userId },
          after: {
            email,
            display_name: name,
            role: "super_admin",
            assignment_id: role.rows[0]!.id,
          },
        });
      });
    } catch (error) {
      await authAdmin.deleteUser(userId);
      throw error;
    }
    console.log(`Super Admin ${email} created. Sign in and enrol TOTP to continue.`);
  } finally {
    await db.end();
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
