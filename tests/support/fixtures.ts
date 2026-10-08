import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { Actor, RoleAssignment, StaffRole } from "@/lib/auth/roles";

/** Pool connected as app_server, exactly like the application. */
export function appPool(max = 10): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (copy .env.example to .env.local)");
  return new Pool({ connectionString: url, max });
}

/** Owner connection for fixtures only (local stack). Never used by application code. */
export function adminPool(): Pool {
  const url = process.env.TEST_ADMIN_DATABASE_URL;
  if (!url) throw new Error("TEST_ADMIN_DATABASE_URL is not set");
  return new Pool({ connectionString: url, max: 2 });
}

export interface RoleSpec {
  role: StaffRole;
  electionId?: string | null;
  boothId?: string | null;
}

export interface StaffFixture {
  userId: string;
  email: string;
  roles: RoleAssignment[];
}

/** Creates an auth user, a staff row and role assignments directly in the database. */
export async function createStaffFixture(
  admin: Pool,
  roles: RoleSpec[],
  options: { active?: boolean } = {},
): Promise<StaffFixture> {
  const userId = randomUUID();
  const email = `${userId}@fixture.test`;
  await admin.query(
    "insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')",
    [userId, email],
  );
  const active = options.active ?? true;
  await admin.query(
    `insert into public.staff (user_id, email, display_name, active, deactivated_at)
     values ($1, $2, 'Fixture', $3, case when $3 then null else now() end)`,
    [userId, email, active],
  );
  const assignments: RoleAssignment[] = [];
  for (const spec of roles) {
    const { rows } = await admin.query<{ id: string }>(
      `insert into public.staff_roles (user_id, role, election_id, booth_id)
       values ($1, $2, $3, $4) returning id`,
      [userId, spec.role, spec.electionId ?? null, spec.boothId ?? null],
    );
    assignments.push({
      id: rows[0]!.id,
      role: spec.role,
      electionId: spec.electionId ?? null,
      boothId: spec.boothId ?? null,
    });
  }
  return { userId, email, roles: assignments };
}

export function actorFor(staff: StaffFixture, overrides: Partial<Actor> = {}): Actor {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    userId: staff.userId,
    sessionId: randomUUID(),
    email: staff.email,
    displayName: "Fixture",
    roles: staff.roles,
    aal: "aal2",
    authTimes: { password: nowSeconds, totp: nowSeconds },
    ...overrides,
  };
}

export async function auditEvents(
  db: Pick<Pool, "query">,
  where: { electionId?: string | null; eventType?: string; targetId?: string; actorId?: string },
) {
  const { rows } = await db.query<{
    seq: string;
    payload: Record<string, unknown> & { event_type: string };
  }>(
    `select seq, payload from public.audit_events
      where ($1::boolean is false or chain_key = coalesce($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid))
        and ($3::text is null or payload->>'event_type' = $3)
        and ($4::text is null or payload->'target'->>'id' = $4)
        and ($5::text is null or payload->'actor'->>'user_id' = $5)
      order by chain_key, seq`,
    [
      where.electionId !== undefined,
      where.electionId ?? null,
      where.eventType ?? null,
      where.targetId ?? null,
      where.actorId ?? null,
    ],
  );
  return rows;
}
