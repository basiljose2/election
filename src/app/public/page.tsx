import type { Metadata } from "next";
import Link from "next/link";
import { PageShell } from "@/components/ui";
import { getPool } from "@/lib/db/pool";
import { listPublicElections } from "@/lib/transparency/public-data";

export const metadata: Metadata = { title: "Elections · Campus EVM" };

const STATUS: Record<string, string> = {
  frozen: "Ballots published",
  polling_open: "Polling open",
  polling_completed: "Polling completed",
  results_declared: "Results declared",
  archived: "Archived",
};

/** The public entry point: every Election whose setup has been frozen, with no login. */
export default async function PublicIndex() {
  const elections = await listPublicElections(getPool());
  return (
    <PageShell title="Elections">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Everything here is public: what is on every ballot, live turnout, and (after declaration) a
        bundle anyone can use to verify the result without trusting this server.
      </p>
      {elections.length === 0 ? (
        <p>No elections have been published yet.</p>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="public-elections">
          {elections.map((e) => (
            <li key={e.id} className="rounded-md border border-zinc-300 p-4 dark:border-zinc-700">
              <Link className="text-lg font-medium underline" href={`/public/elections/${e.id}`}>
                {e.name}
              </Link>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                {e.pollingDate} · {STATUS[e.status] ?? e.status}
              </p>
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  );
}
