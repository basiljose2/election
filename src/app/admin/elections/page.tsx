import type { Metadata } from "next";
import Link from "next/link";
import { Button, Field, first, Notice, PageShell } from "@/components/ui";
import { requireActorForPage } from "@/lib/auth/current-actor";
import { superAdminGrant } from "@/lib/auth/roles";
import { getPool } from "@/lib/db/pool";
import { listElections } from "@/lib/setup/queries";
import { cloneElectionAction, createElectionAction } from "./actions";

export const metadata: Metadata = { title: "Elections · Campus EVM" };

export default async function ElectionsPage({ searchParams }: PageProps<"/admin/elections">) {
  const actor = await requireActorForPage();
  const params = await searchParams;
  const ok = first(params.ok);
  const error = first(params.error);
  const elections = await listElections(getPool(), actor);
  const isSuperAdmin = !!superAdminGrant(actor);

  return (
    <PageShell title="Elections">
      <Link href="/staff" className="text-sm underline">
        Back
      </Link>
      {ok && <Notice tone="info">{ok}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Your elections</h2>
        {elections.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">No elections yet.</p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="elections">
            {elections.map((e) => (
              <li key={e.id}>
                <Link
                  href={`/admin/elections/${e.id}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
                >
                  <span className="font-medium">{e.name}</span>
                  <span className="text-sm text-zinc-600 dark:text-zinc-400">
                    {e.polling_date} · {e.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {isSuperAdmin && (
        <>
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-medium">Create election</h2>
            <form action={createElectionAction} className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" name="name" required />
              <Field label="Polling date" name="pollingDate" type="date" required />
              <Field label="Description" name="description" />
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" name="notaEnabled" /> Enable NOTA
              </label>
              <div>
                <Button type="submit">Create election</Button>
              </div>
            </form>
          </section>

          {elections.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-medium">Clone an election for rehearsal</h2>
              <form action={cloneElectionAction} className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-sm font-medium">
                  Source election
                  <select
                    name="sourceElectionId"
                    className="h-10 rounded-md border border-zinc-300 bg-transparent px-2 dark:border-zinc-700"
                  >
                    {elections.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </label>
                <Field label="Name of the copy" name="name" required />
                <div>
                  <Button type="submit" variant="plain">
                    Clone as Draft
                  </Button>
                </div>
              </form>
            </section>
          )}
        </>
      )}
    </PageShell>
  );
}
