import type { Metadata } from "next";
import Link from "next/link";
import { Button, PageShell } from "@/components/ui";
import { requireActorForPage } from "@/lib/auth/current-actor";
import { ROLE_LABELS, superAdminGrant } from "@/lib/auth/roles";
import { signOutAction } from "../(auth)/actions";

export const metadata: Metadata = { title: "Staff · Campus EVM" };

export default async function StaffHome() {
  const actor = await requireActorForPage();

  return (
    <PageShell title={`Signed in as ${actor.displayName}`}>
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">Your roles</h2>
        {actor.roles.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">No roles assigned yet.</p>
        ) : (
          <ul className="list-disc pl-6 text-sm" data-testid="roles">
            {actor.roles.map((r) => (
              <li key={r.id}>
                {ROLE_LABELS[r.role]}
                {r.electionId && ` · election ${r.electionId}`}
                {r.boothId && ` · booth ${r.boothId}`}
              </li>
            ))}
          </ul>
        )}
      </section>
      <nav className="flex gap-4 text-sm underline">
        {superAdminGrant(actor) && <Link href="/admin/staff">Manage staff</Link>}
      </nav>
      <form action={signOutAction}>
        <Button type="submit" variant="plain">
          Sign out
        </Button>
      </form>
    </PageShell>
  );
}
