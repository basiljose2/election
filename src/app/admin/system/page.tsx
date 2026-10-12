import type { Metadata } from "next";
import Link from "next/link";
import { Button, Field, first, Notice, PageShell } from "@/components/ui";
import { appendAuditEvent } from "@/lib/audit/append";
import { requireActorForPage } from "@/lib/auth/current-actor";
import { superAdminGrant } from "@/lib/auth/roles";
import { ERASE_PHRASE, getEraseStatus } from "@/lib/commands/system";
import { recordDeniedAttempt } from "@/lib/commands/gateway";
import { getPool } from "@/lib/db/pool";
import { eraseAllDataAction } from "./actions";

export const metadata: Metadata = { title: "Test data · Campus EVM" };

/** The Super Admin's test-data page: erase everything, if (and only if) the database allows. */
export default async function SystemPage({ searchParams }: PageProps<"/admin/system">) {
  const actor = await requireActorForPage();
  if (!superAdminGrant(actor)) {
    await recordDeniedAttempt(
      { db: getPool(), appendAudit: appendAuditEvent },
      actor,
      "page.admin_system",
      { electionId: null, target: { type: "page", id: "/admin/system" } },
    );
    return (
      <PageShell title="Not authorized">
        <Notice tone="error">Only a Super Admin can open this page.</Notice>
      </PageShell>
    );
  }
  const params = await searchParams;
  const ok = first(params.ok);
  const error = first(params.error);
  const status = await getEraseStatus(getPool());

  return (
    <PageShell title="Test data">
      <Link href="/staff" className="text-sm underline">
        Back
      </Link>
      {ok && <Notice tone="info">{ok}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      <section className="flex flex-col gap-2" aria-label="Current data">
        <h2 className="text-lg font-medium">What is in this database</h2>
        <dl className="grid grid-cols-2 gap-1 text-sm sm:grid-cols-4" data-testid="erase-counts">
          <dt>Elections</dt>
          <dd data-testid="count-elections">{status.elections}</dd>
          <dt>Booths</dt>
          <dd>{status.booths}</dd>
          <dt>Ballots cast</dt>
          <dd>{status.ballotsCast}</dd>
          <dt>Declared results</dt>
          <dd>{status.results}</dd>
        </dl>
      </section>

      <section className="flex flex-col gap-3" aria-label="Erase all data">
        <h2 className="text-lg font-medium">Erase all election data</h2>
        {status.allowed ? (
          <Notice tone="error">
            Erasing is switched ON for this database. Use it only on a test or rehearsal database.
          </Notice>
        ) : (
          <Notice tone="info">
            Erasing is switched OFF for this database, which is the default and the right setting
            for a real election. The database owner turns it on for a test or rehearsal database
            (see docs/runbooks/test-data-erase.md); this application cannot.
          </Notice>
        )}
        <p className="text-sm">
          This permanently deletes every election with its setup, terminals, ballots, votes,
          tallies, results and the whole audit log, and election-scoped staff roles. Staff accounts
          and Super Admin roles are kept. It cannot be undone, and the Returning Officers and
          Presiding Officers will need to be assigned again.
        </p>
        <form action={eraseAllDataAction} className="flex max-w-md flex-col gap-3">
          <Field
            label={`Type ${ERASE_PHRASE} to confirm`}
            name="confirmation"
            autoComplete="off"
            disabled={!status.allowed}
          />
          <div>
            <Button type="submit" variant="danger" disabled={!status.allowed}>
              Erase all election data
            </Button>
          </div>
        </form>
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          You will be asked to confirm your password and authenticator code if you have not done so
          in the last 5 minutes.
        </p>
      </section>
    </PageShell>
  );
}
