import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageShell } from "@/components/ui";
import { ResultsView } from "@/components/results-view";
import { getPool } from "@/lib/db/pool";
import type { ResultDocument } from "@/lib/results/declare";
import { getPublicResult, getPublicSetup } from "@/lib/transparency/public-data";

export const metadata: Metadata = { title: "Results · Campus EVM" };

/**
 * The declared Result exactly as signed. Before declaration there is nothing to show: no
 * per-candidate data exists outside the sealed database until then.
 */
export default async function PublicResultsPage({
  params,
}: PageProps<"/public/elections/[id]/results">) {
  const { id } = await params;
  const setup = await getPublicSetup(getPool(), id);
  if (!setup) notFound();
  const result = await getPublicResult(getPool(), id);

  if (!result) {
    return (
      <PageShell title={`${setup.election.name}: results`}>
        <p data-testid="not-declared">Results have not been declared yet.</p>
        <Link className="text-sm underline" href={`/public/elections/${id}`}>
          Back to the election
        </Link>
      </PageShell>
    );
  }
  const doc = JSON.parse(result.canonicalJson) as ResultDocument;
  return (
    <PageShell title={`${doc.election_name}: results`}>
      <ResultsView
        doc={doc}
        resultHash={result.resultHash}
        backHref={`/public/elections/${id}`}
        backLabel="Back to the election"
        exportLinks={[
          { href: `/public/elections/${id}/bundle`, label: "Verification bundle (zip)" },
          { href: `/public/api/elections/${id}/result`, label: "Signed Result (JSON)" },
          { href: "/verify", label: "Verify a bundle" },
        ]}
      />
    </PageShell>
  );
}
