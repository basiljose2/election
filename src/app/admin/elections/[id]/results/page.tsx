import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Notice, PageShell } from "@/components/ui";
import { requireActorForPage } from "@/lib/auth/current-actor";
import { electionGrant, superAdminGrant } from "@/lib/auth/roles";
import { getPool } from "@/lib/db/pool";
import { loadResult } from "@/lib/results/declare";

export const metadata: Metadata = { title: "Results · Campus EVM" };

import { ResultsView } from "@/components/results-view";
export default async function ResultsPage({ params }: PageProps<"/admin/elections/[id]/results">) {
  const actor = await requireActorForPage();
  const { id: electionId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(electionId)) notFound();

  const grant =
    superAdminGrant(actor) ?? electionGrant(actor, electionId, ["returning_officer", "observer"]);
  if (!grant) {
    return (
      <PageShell title="Not authorized">
        <Notice tone="error">You do not have access to this election.</Notice>
      </PageShell>
    );
  }
  const result = await loadResult(getPool(), electionId);
  if (!result) {
    return (
      <PageShell title="Results">
        <Notice tone="info">Results have not been declared yet.</Notice>
        <Link href={`/admin/elections/${electionId}/dashboard`} className="text-sm underline">
          Back to the dashboard
        </Link>
      </PageShell>
    );
  }
  const doc = result.document;
  const canExport = Boolean(electionGrant(actor, electionId, ["returning_officer"]));

  return (
    <PageShell title={`${doc.election_name}: results`}>
      <ResultsView
        doc={doc}
        resultHash={result.resultHash}
        backHref={`/admin/elections/${electionId}/dashboard`}
        backLabel="Back to the dashboard"
        exportLinks={
          canExport
            ? [
                { href: `/api/elections/${electionId}/results/pdf`, label: "Download PDF" },
                { href: `/api/elections/${electionId}/results/csv`, label: "Download CSV" },
                {
                  href: `/api/elections/${electionId}/results/json`,
                  label: "Download signed JSON",
                },
              ]
            : []
        }
      />
    </PageShell>
  );
}
