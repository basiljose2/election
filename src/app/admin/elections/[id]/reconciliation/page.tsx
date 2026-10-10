import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button, first, Notice, PageShell } from "@/components/ui";
import { requireActorForPage } from "@/lib/auth/current-actor";
import { electionGrant } from "@/lib/auth/roles";
import { getPool } from "@/lib/db/pool";
import { latestReconciliation, type CheckResult } from "@/lib/reconciliation/run";
import { reconcileAction } from "./actions";

export const metadata: Metadata = { title: "Reconciliation report · Campus EVM" };

const LABELS: Record<string, string> = {
  audit_chain: "Audit hash chain is intact",
  setup_unchanged: "Setup Hash unchanged",
  ballot_definitions_unchanged: "Ballot Definitions unchanged",
  no_pending_sessions: "No Ballot Session pending",
  booth_closed: "Booth is closed",
  tally_present: "Booth Tally exists",
  tally_signature: "Booth Tally signature valid",
  count_and_root_match: "Stored votes match the Booth Tally (count and Merkle root)",
  selection_signatures: "Every Vote Selection signature valid",
  answer_rule: "Ballot answers equal ballots cast for every Post",
  no_unmapped_selections: "No Vote Selection on an unmapped Post",
};

const Result = ({ passed }: { passed: boolean }) => (
  <strong className={passed ? "text-green-700" : "text-red-700"}>
    {passed ? "PASS" : "FAILED"}
  </strong>
);

function Checks({ checks, testId }: { checks: Array<CheckResult<string>>; testId: string }) {
  return (
    <ul className="flex flex-col gap-1 text-sm" data-testid={testId}>
      {checks.map((c) => (
        <li key={c.check} data-check={c.check} data-passed={c.passed}>
          <Result passed={c.passed} /> {LABELS[c.check] ?? c.check}
          {c.detail && <span className="text-zinc-600 dark:text-zinc-400"> ({c.detail})</span>}
        </li>
      ))}
    </ul>
  );
}

/** The Returning Officer and the Observers of the Election see the report; totals only. */
export default async function ReconciliationPage({
  params,
  searchParams,
}: PageProps<"/admin/elections/[id]/reconciliation">) {
  const actor = await requireActorForPage();
  const { id: electionId } = await params;
  const query = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(electionId)) notFound();

  const grant = electionGrant(actor, electionId, ["returning_officer", "observer"]);
  if (!grant) {
    return (
      <PageShell title="Not authorized">
        <Notice tone="error">
          Only this election&apos;s Returning Officer and Observers can open it.
        </Notice>
      </PageShell>
    );
  }
  const isRo = grant.role === "returning_officer";
  const report = await latestReconciliation(getPool(), electionId);
  const ok = first(query.ok);
  const error = first(query.error);

  return (
    <PageShell title="Reconciliation report">
      <Link href={`/admin/elections/${electionId}`} className="text-sm underline">
        Back to the election
      </Link>
      {ok && <Notice tone="info">{ok}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {isRo && (
        <form action={reconcileAction}>
          <input type="hidden" name="electionId" value={electionId} />
          <Button type="submit">Run reconciliation</Button>
        </form>
      )}
      {!report && <Notice tone="info">The election has not been reconciled yet.</Notice>}
      {report && (
        <div className="flex flex-col gap-6" data-testid="reconciliation-report">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Run at {new Date(report.ranAt).toLocaleString()}. Totals, flags and hashes only: no
            per-candidate counts.
          </p>

          <section className="flex flex-col gap-2">
            <h2 className="text-lg font-medium">Election-wide checks</h2>
            <Checks checks={report.electionChecks} testId="election-checks" />
          </section>

          <section className="flex flex-col gap-4">
            <h2 className="text-lg font-medium">Booths</h2>
            {report.booths.map((b) => (
              <div
                key={b.boothId}
                data-testid={`booth-${b.boothId}`}
                className="flex flex-col gap-2 rounded-md border border-zinc-300 p-4 dark:border-zinc-700"
              >
                <h3 className="font-medium">
                  {b.boothName} <Result passed={b.passed} />
                </h3>
                <p className="text-sm">
                  Ballots cast {b.ballotsCast} · cancelled {b.ballotsCancelled}
                  {b.tallyHash && (
                    <>
                      {" "}
                      · tally hash <span className="font-mono break-all">{b.tallyHash}</span>
                    </>
                  )}
                </p>
                {b.answers.length > 0 && (
                  <ul className="text-sm">
                    {b.answers.map((a) => (
                      <li key={a.postId}>
                        {a.postName}: {a.answers} ballot answers
                      </li>
                    ))}
                  </ul>
                )}
                <Checks checks={b.checks} testId={`checks-${b.boothId}`} />
              </div>
            ))}
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-lg font-medium">Posts</h2>
            <ul className="flex flex-col gap-1 text-sm" data-testid="post-outcomes">
              {report.posts.map((p) => (
                <li key={p.postId} data-status={p.status}>
                  {p.postName}: <Result passed={p.status === "pass"} />
                  {p.reasons.length > 0 && <span> ({p.reasons.join("; ")})</span>}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </PageShell>
  );
}
