import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageShell } from "@/components/ui";
import { getPool } from "@/lib/db/pool";
import { getPublicStatus } from "@/lib/transparency/public-data";
import { StatusBoard } from "./status-board";

export const metadata: Metadata = { title: "Live status · Campus EVM" };

export default async function PublicStatusPage({
  params,
}: PageProps<"/public/elections/[id]/status">) {
  const { id } = await params;
  const status = await getPublicStatus(getPool(), id);
  if (!status) notFound();
  return (
    <PageShell title={`${status.electionName}: live status`}>
      <Link className="text-sm underline" href={`/public/elections/${id}`}>
        Back to the election
      </Link>
      <StatusBoard initial={status} />
    </PageShell>
  );
}
