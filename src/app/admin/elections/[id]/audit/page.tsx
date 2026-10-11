import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Notice, PageShell } from "@/components/ui";
import { requireActorForPage } from "@/lib/auth/current-actor";
import { isCommandError } from "@/lib/commands/errors";
import { getPool } from "@/lib/db/pool";
import { getAuditFeed } from "@/lib/transparency/audit-feed";
import { AuditFeed } from "./audit-feed";

export const metadata: Metadata = { title: "Audit feed · Campus EVM" };

/** The Observer's live view of the Election's audit log (and a link to the reconciliation). */
export default async function AuditFeedPage({ params }: PageProps<"/admin/elections/[id]/audit">) {
  const actor = await requireActorForPage();
  const { id: electionId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(electionId)) notFound();

  let feed;
  try {
    feed = await getAuditFeed(getPool(), actor, electionId, 0);
  } catch (error) {
    if (isCommandError(error) && error.code === "forbidden") {
      return (
        <PageShell title="Not authorized">
          <Notice tone="error">
            Only this election&apos;s Observers and officers can follow its audit log.
          </Notice>
        </PageShell>
      );
    }
    throw error;
  }

  return (
    <PageShell title="Audit feed">
      <div className="flex gap-4 text-sm">
        <Link className="underline" href={`/admin/elections/${electionId}/reconciliation`}>
          Reconciliation report
        </Link>
        <Link className="underline" href={`/admin/elections/${electionId}/dashboard`}>
          Dashboard
        </Link>
      </div>
      <AuditFeed electionId={electionId} initial={feed.events} />
    </PageShell>
  );
}
