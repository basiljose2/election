import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Notice, PageShell } from "@/components/ui";
import { requireActorForPage } from "@/lib/auth/current-actor";
import { electionGrant, superAdminGrant } from "@/lib/auth/roles";
import { getPool } from "@/lib/db/pool";
import type { CandidateOutcome, PostResult } from "@/lib/results/compute";
import { loadResult } from "@/lib/results/declare";
import { outcomeLabel, postStatusLabel } from "@/lib/results/exports";

export const metadata: Metadata = { title: "Results · Campus EVM" };

const BADGE: Record<string, string> = {
  elected: "bg-blue-100 text-blue-950 dark:bg-blue-950 dark:text-blue-100",
  tie: "bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-100",
  unopposed: "bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100",
  withheld: "bg-red-100 text-red-950 dark:bg-red-950 dark:text-red-100",
  nota: "bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100",
};

function Badge({ kind, children }: { kind: string; children: React.ReactNode }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${BADGE[kind]}`}>
      {children}
    </span>
  );
}

const pct = (votes: number, answers: number | null) =>
  answers && answers > 0 ? `${((votes / answers) * 100).toFixed(1)}%` : "-";

const BAR_FILL = {
  elected: "fill-[var(--bar-elected)]",
  other: "fill-[var(--bar-other)]",
  nota: "fill-[var(--bar-nota)]",
} as const;

function Bar({
  label,
  votes,
  max,
  share,
  outcome,
  kind,
}: {
  label: string;
  votes: number;
  max: number;
  share: string;
  outcome: string;
  kind: "elected" | "other" | "nota";
}) {
  const width = max > 0 ? Math.max((votes / max) * 100, votes > 0 ? 1 : 0) : 0;
  return (
    <li
      className="grid grid-cols-[minmax(7rem,12rem)_1fr_auto] items-center gap-3"
      data-outcome={outcome}
    >
      <span className="truncate text-sm">{label}</span>
      {/* SVG, not inline styles: the CSP allows presentation attributes but not style="" */}
      <svg className="h-4 w-full" aria-hidden role="presentation">
        <rect width={`${width}%`} height="16" rx="4" className={BAR_FILL[kind]} data-testid="bar" />
        {/* square the baseline end: only the data-end is rounded */}
        {votes > 0 && <rect width="4" height="16" className={BAR_FILL[kind]} />}
      </svg>
      <span className="text-right text-sm tabular-nums">
        <strong>{votes}</strong> <span className="text-zinc-600 dark:text-zinc-400">{share}</span>
      </span>
    </li>
  );
}

function PostCard({ post }: { post: PostResult }) {
  const max = Math.max(0, ...post.candidates.map((c) => c.votes ?? 0), post.nota ?? 0);
  const outcomeOf = (outcome: CandidateOutcome) => outcomeLabel(outcome);
  return (
    <section
      data-testid={`post-${post.postId}`}
      data-status={post.status}
      className="flex flex-col gap-3 rounded-md border border-zinc-300 p-4 dark:border-zinc-700"
    >
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-medium">{post.name}</h3>
        <span className="text-sm text-zinc-600 dark:text-zinc-400">
          {post.seats} seat{post.seats === 1 ? "" : "s"}
        </span>
        <Badge kind={post.status}>{postStatusLabel(post.status)}</Badge>
        {post.notaExceededWinner && <Badge kind="nota">NOTA exceeded winner</Badge>}
      </header>

      {post.status === "withheld" ? (
        <p className="text-sm" data-testid="withheld-note">
          Withheld: {post.withheldReason ?? "integrity check failed"}. No counts are shown for this
          Post.
        </p>
      ) : post.status === "unopposed" ? (
        <ul className="flex flex-col gap-1 text-sm">
          {post.candidates.map((c) => (
            <li key={c.id}>
              {c.serial ?? "-"}. {c.name}: <Badge kind="unopposed">Elected unopposed</Badge>
            </li>
          ))}
        </ul>
      ) : (
        <>
          <ul className="flex flex-col gap-2" aria-label={`Votes for ${post.name}`}>
            {post.candidates.map((c) => (
              <Bar
                key={c.id}
                label={`${c.serial ?? "-"}. ${c.name}`}
                votes={c.votes ?? 0}
                max={max}
                share={pct(c.votes ?? 0, post.answers)}
                outcome={outcomeOf(c.outcome)}
                kind={c.outcome === "elected" ? "elected" : "other"}
              />
            ))}
            {post.nota !== null && (
              <Bar
                label="NOTA"
                votes={post.nota}
                max={max}
                share={pct(post.nota, post.answers)}
                outcome="NOTA"
                kind="nota"
              />
            )}
          </ul>
          <ul className="flex flex-wrap gap-x-4 text-xs text-zinc-600 dark:text-zinc-400">
            <li>
              <svg className="inline h-2 w-2" aria-hidden role="presentation" viewBox="0 0 8 8">
                <circle cx="4" cy="4" r="4" className={BAR_FILL.elected} />
              </svg>{" "}
              Elected
            </li>
            <li>
              <svg className="inline h-2 w-2" aria-hidden role="presentation" viewBox="0 0 8 8">
                <circle cx="4" cy="4" r="4" className={BAR_FILL.other} />
              </svg>{" "}
              Not elected / tied
            </li>
            <li>
              <svg className="inline h-2 w-2" aria-hidden role="presentation" viewBox="0 0 8 8">
                <circle cx="4" cy="4" r="4" className={BAR_FILL.nota} />
              </svg>{" "}
              NOTA
            </li>
          </ul>
          <ul className="text-sm" data-testid={`outcomes-${post.postId}`}>
            {post.candidates.map((c) => (
              <li key={c.id}>
                {c.name}: {outcomeOf(c.outcome)}
              </li>
            ))}
          </ul>
          {post.status === "tie" && (
            <p className="text-sm" data-testid="tie-note">
              {post.tiedSeats} seat{post.tiedSeats === 1 ? "" : "s"} tied. The system does not
              resolve ties.
            </p>
          )}
          {post.margin !== null && (
            <p className="text-sm" data-testid="margin">
              Margin: <strong>{post.margin}</strong> votes between the last Elected Candidate and
              the next.
            </p>
          )}
          <p className="text-xs text-zinc-600 dark:text-zinc-400">Valid answers: {post.answers}</p>
        </>
      )}
    </section>
  );
}

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
  const names = new Map(doc.posts.flatMap((p) => p.candidates.map((c) => [c.id, c.name] as const)));
  const postNames = new Map(doc.posts.map((p) => [p.postId, p.name]));

  return (
    <PageShell title={`${doc.election_name}: results`}>
      <div className="results-viz flex flex-col gap-6" data-testid="results">
        <Link
          href={`/admin/elections/${electionId}/dashboard`}
          className="no-print text-sm underline"
        >
          Back to the dashboard
        </Link>

        <section aria-label="Totals" className="grid grid-cols-3 gap-3">
          {[
            ["Ballots cast", doc.totals.ballots_cast, "tile-cast"],
            ["Ballots cancelled", doc.totals.ballots_cancelled, "tile-cancelled"],
            ["Booths", doc.totals.booths, "tile-booths"],
          ].map(([label, value, id]) => (
            <div key={id} className="rounded-md border border-zinc-300 p-4 dark:border-zinc-700">
              <p className="text-sm text-zinc-600 dark:text-zinc-400">{label}</p>
              <p className="text-4xl font-semibold" data-testid={String(id)}>
                {value}
              </p>
            </div>
          ))}
        </section>

        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Declared {new Date(doc.declared_at).toLocaleString()} · Result hash{" "}
          <span className="font-mono break-all" data-testid="result-hash">
            {result.resultHash}
          </span>
        </p>

        {canExport && (
          <div className="no-print flex gap-4 text-sm" data-testid="exports">
            <a className="underline" href={`/api/elections/${electionId}/results/pdf`}>
              Download PDF
            </a>
            <a className="underline" href={`/api/elections/${electionId}/results/csv`}>
              Download CSV
            </a>
            <a className="underline" href={`/api/elections/${electionId}/results/json`}>
              Download signed JSON
            </a>
          </div>
        )}

        <section className="flex flex-col gap-4">
          <h2 className="text-xl font-medium">Posts</h2>
          {doc.posts.map((post) => (
            <PostCard key={post.postId} post={post} />
          ))}
        </section>

        {doc.booth_wise.length > 0 && (
          <section className="flex flex-col gap-3">
            <h2 className="text-xl font-medium">Booth-wise votes</h2>
            <table className="w-full text-left text-sm" data-testid="booth-wise">
              <thead>
                <tr className="border-b border-zinc-300 dark:border-zinc-700">
                  <th className="py-2">Booth</th>
                  <th>Post</th>
                  <th>Candidate</th>
                  <th className="text-right">Votes</th>
                </tr>
              </thead>
              <tbody>
                {doc.booth_wise.flatMap((entry) =>
                  entry.rows.map((row) => (
                    <tr
                      key={`${entry.booth_id}-${entry.post_id}-${row.candidate_id ?? "nota"}`}
                      className="border-b border-zinc-200 dark:border-zinc-800"
                      data-post={entry.post_id}
                    >
                      <td className="py-1">{entry.booth_name}</td>
                      <td>{postNames.get(entry.post_id) ?? entry.post_id}</td>
                      <td>{row.candidate_id ? (names.get(row.candidate_id) ?? "?") : "NOTA"}</td>
                      <td className="text-right tabular-nums">{row.votes}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </PageShell>
  );
}
