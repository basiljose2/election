import type { Metadata } from "next";
import Link from "next/link";
import { Button, Field, first, Notice, PageShell } from "@/components/ui";
import { appendAuditEvent } from "@/lib/audit/append";
import { requireActorForPage } from "@/lib/auth/current-actor";
import { ROLE_LABELS, STAFF_ROLES, superAdminGrant, type StaffRole } from "@/lib/auth/roles";
import { recordDeniedAttempt } from "@/lib/commands/gateway";
import { getPool } from "@/lib/db/pool";
import {
  assignRoleAction,
  createStaffAction,
  deactivateStaffAction,
  revokeRoleAction,
} from "./actions";

export const metadata: Metadata = { title: "Manage staff · Campus EVM" };

interface StaffRow {
  user_id: string;
  email: string;
  display_name: string;
  active: boolean;
  roles: Array<{
    id: string;
    role: StaffRole;
    election_id: string | null;
    booth_id: string | null;
  }>;
}

async function loadStaff(): Promise<StaffRow[]> {
  const { rows } = await getPool().query<StaffRow>(
    `select s.user_id, s.email, s.display_name, s.active,
            coalesce(json_agg(json_build_object('id', r.id, 'role', r.role,
                     'election_id', r.election_id, 'booth_id', r.booth_id)
                     order by r.assigned_at) filter (where r.id is not null), '[]') as roles
       from public.staff s
       left join public.staff_roles r on r.user_id = s.user_id and r.revoked_at is null
      group by s.user_id
      order by s.active desc, s.email`,
  );
  return rows;
}

export default async function ManageStaffPage({ searchParams }: PageProps<"/admin/staff">) {
  const actor = await requireActorForPage();
  if (!superAdminGrant(actor)) {
    await recordDeniedAttempt(
      { db: getPool(), appendAudit: appendAuditEvent },
      actor,
      "page.admin_staff",
      {
        electionId: null,
        target: { type: "page", id: "/admin/staff" },
      },
    );
    return (
      <PageShell title="Not authorized">
        <Notice tone="error">Only a Super Admin can manage staff.</Notice>
      </PageShell>
    );
  }

  const params = await searchParams;
  const ok = first(params.ok);
  const error = first(params.error);
  const staff = await loadStaff();

  return (
    <PageShell title="Manage staff">
      <Link href="/staff" className="text-sm underline">
        Back
      </Link>
      {ok && <Notice tone="info">{ok}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Create staff account</h2>
        <form action={createStaffAction} className="grid gap-3 sm:grid-cols-2">
          <Field label="Email" name="email" type="email" required />
          <Field label="Display name" name="displayName" required />
          <Field
            label="Initial password (min. 12 characters)"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
          />
          <div className="flex items-end">
            <Button type="submit">Create</Button>
          </div>
        </form>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-medium">Staff</h2>
        {staff.map((s) => (
          <article
            key={s.user_id}
            data-testid={`staff-${s.email}`}
            className="flex flex-col gap-3 rounded-md border border-zinc-200 p-4 dark:border-zinc-800"
          >
            <header className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium">{s.display_name}</p>
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  {s.email} · {s.active ? "active" : "deactivated"}
                </p>
              </div>
              {s.active && s.user_id !== actor.userId && (
                <form action={deactivateStaffAction}>
                  <input type="hidden" name="userId" value={s.user_id} />
                  <Button type="submit" variant="danger">
                    Deactivate
                  </Button>
                </form>
              )}
            </header>

            <ul className="flex flex-col gap-2 text-sm" data-testid="role-assignments">
              {s.roles.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2">
                  <span>
                    {ROLE_LABELS[r.role]}
                    {r.election_id && ` · election ${r.election_id}`}
                    {r.booth_id && ` · booth ${r.booth_id}`}
                  </span>
                  <form action={revokeRoleAction}>
                    <input type="hidden" name="assignmentId" value={r.id} />
                    <Button type="submit" variant="plain">
                      Revoke
                    </Button>
                  </form>
                </li>
              ))}
            </ul>

            {s.active && (
              <form action={assignRoleAction} className="grid gap-2 sm:grid-cols-4">
                <input type="hidden" name="userId" value={s.user_id} />
                <label className="flex flex-col gap-1 text-sm font-medium">
                  Role
                  <select
                    name="role"
                    className="h-10 rounded-md border border-zinc-300 bg-transparent px-2 dark:border-zinc-700"
                  >
                    {STAFF_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {ROLE_LABELS[role]}
                      </option>
                    ))}
                  </select>
                </label>
                <Field label="Election ID" name="electionId" />
                <Field label="Booth ID" name="boothId" />
                <div className="flex items-end">
                  <Button type="submit" variant="plain">
                    Assign role
                  </Button>
                </div>
              </form>
            )}
          </article>
        ))}
      </section>
    </PageShell>
  );
}
