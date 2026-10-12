import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button, first, Notice, PageShell } from "@/components/ui";
import { requireActorForPage } from "@/lib/auth/current-actor";
import { electionGrant } from "@/lib/auth/roles";
import { isCommandError } from "@/lib/commands/errors";
import { getPool } from "@/lib/db/pool";
import { getPollingDashboard } from "@/lib/results/polling-dashboard";
import { completePollsAction, declareResultsAction, startPollingAction } from "./actions";
import { LiveBooths } from "./live-booths";

export const metadata: Metadata = { title: "Election dashboard · Campus EVM" };

export default async function DashboardPage({
  params,
  searchParams,
}: PageProps<"/admin/elections/[id]/dashboard">) {
  const actor = await requireActorForPage();
  const { id: electionId } = await params;
  const query = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(electionId)) notFound();

  let dashboard;
  try {
    dashboard = await getPollingDashboard(getPool(), actor, electionId);
  } catch (error) {
    if (isCommandError(error) && error.code === "forbidden") {
      return (
        <PageShell title="Not authorized">
          <Notice tone="error">You do not have access to this election.</Notice>
        </PageShell>
      );
    }
    if (isCommandError(error) && error.code === "not_found") notFound();
    throw error;
  }

  const canAct = Boolean(electionGrant(actor, electionId, ["returning_officer"]));
  const status = dashboard.electionStatus;
  const allClosed = dashboard.totals.boothsClosed === dashboard.totals.booths;
  const ok = first(query.ok);
  const error = first(query.error);

  return (
    <PageShell title={`${dashboard.electionName}: dashboard`}>
      <Link href={`/admin/elections/${electionId}`} className="text-sm underline">
        Back to the election
      </Link>
      {ok && <Notice tone="info">{ok}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <p className="text-sm text-zinc-600 dark:text-zinc-400" data-testid="dashboard-status">
        Status: <strong>{status.replace(/_/g, " ")}</strong>
      </p>

      <LiveBooths initial={dashboard} canForceClose={canAct} />

      {status === "frozen" && canAct && (
        <section className="flex flex-col gap-2" aria-label="Start polling">
          <p className="text-sm">
            Starting polling opens the election: Presiding Officers can then open their polls and
            real ballots can be issued. Mock polls can be run before or after.
          </p>
          <form action={startPollingAction}>
            <input type="hidden" name="electionId" value={electionId} />
            <Button type="submit" data-testid="start-polling">
              Start polling
            </Button>
          </form>
        </section>
      )}

      {status === "polling_open" && canAct && (
        <form action={completePollsAction} className="flex flex-col gap-2">
          <input type="hidden" name="electionId" value={electionId} />
          <div>
            <Button type="submit" disabled={!allClosed} data-testid="complete-polls">
              Complete all polls
            </Button>
          </div>
          {!allClosed && (
            <p className="text-sm text-zinc-600 dark:text-zinc-400" data-testid="complete-reason">
              Every booth must be Closed first.
            </p>
          )}
        </form>
      )}

      {status === "polling_completed" && (
        <section className="flex flex-col gap-3" aria-label="Declare results">
          <h2 className="text-lg font-medium">Declare results</h2>
          <p className="text-sm">
            Declaring runs the election reconciliation again, reveals the counts and signs the
            Result. It can be done once, and it needs you to confirm your password.
          </p>
          <Link
            href={`/admin/elections/${electionId}/reconciliation`}
            className="text-sm underline"
          >
            Reconciliation report
          </Link>
          {canAct && (
            <form action={declareResultsAction}>
              <input type="hidden" name="electionId" value={electionId} />
              <Button type="submit" data-testid="declare-results">
                Declare results
              </Button>
            </form>
          )}
        </section>
      )}

      {(status === "results_declared" || status === "archived") && (
        <Link
          href={`/admin/elections/${electionId}/results`}
          className="underline"
          data-testid="results-link"
        >
          Open the results
        </Link>
      )}
    </PageShell>
  );
}
