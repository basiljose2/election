import QRCode from "qrcode";
import { Notice } from "@/components/ui";
import { shortHash, type StoredTally } from "@/lib/votes/tally";
import { PrintButton } from "./print-button";

/**
 * The Booth Tally of a closed booth, for the agents present to record: counts, the tally
 * hash (short form, full form and QR code) and a printable view. Totals and hashes only.
 */
export async function BoothTallyScreen({
  tally,
  boothName,
  electionName,
  postNames,
}: {
  tally: StoredTally;
  boothName: string;
  electionName: string;
  postNames: Record<string, string>;
}) {
  const { content } = tally;
  const qr = await QRCode.toString(tally.tallyHash, { type: "svg", margin: 1, width: 200 });
  const failed = tally.status === "failed";

  return (
    <main
      data-testid="booth-tally"
      className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 bg-white px-6 py-8 text-zinc-900 print:max-w-none print:p-0"
    >
      <header className="flex flex-col gap-1">
        <p className="text-sm text-zinc-600">{electionName}</p>
        <h1 className="text-3xl font-semibold">{boothName}: Booth Tally</h1>
        <p className="text-sm text-zinc-600">
          Poll closed at {new Date(content.closed_at).toLocaleString()}
        </p>
      </header>

      {failed && (
        <div role="alert" data-testid="tally-failed">
          <Notice tone="error">
            This Booth Tally is marked FAILED (
            {[...new Set(content.failures.map((f) => f.check))]
              .map((c) => c.replace(/_/g, " "))
              .join(", ")}
            ). The Returning Officer has been alerted. Keep this record.
          </Notice>
        </div>
      )}

      <section aria-label="Counts" className="grid grid-cols-2 gap-4" data-testid="tally-counts">
        <div className="rounded-lg border border-zinc-300 p-4">
          <p className="text-sm text-zinc-600">Ballots cast</p>
          <p className="font-mono text-5xl tabular-nums" data-testid="tally-cast">
            {content.ballots_cast}
          </p>
        </div>
        <div className="rounded-lg border border-zinc-300 p-4">
          <p className="text-sm text-zinc-600">Ballots cancelled</p>
          <p className="font-mono text-5xl tabular-nums" data-testid="tally-cancelled">
            {content.ballots_cancelled}
          </p>
        </div>
      </section>

      <section aria-label="Answers per Post" className="flex flex-col gap-1">
        <h2 className="text-lg font-medium">Ballot answers per Post</h2>
        <ul className="text-base" data-testid="tally-posts">
          {content.posts.map((p) => (
            <li key={p.post_id}>
              {postNames[p.post_id] ?? p.post_id}: <strong>{p.answers}</strong>
            </li>
          ))}
        </ul>
        <p className="text-sm text-zinc-600">
          Vote Selections recorded: {content.selection_rows} · mock rounds held:{" "}
          {content.mock_rounds}
        </p>
      </section>

      <section aria-label="Tally hash" className="flex flex-wrap items-center gap-6">
        <div
          role="img"
          aria-label="QR code of the full tally hash"
          data-testid="tally-qr"
          className="h-48 w-48 shrink-0 bg-white"
          dangerouslySetInnerHTML={{ __html: qr }}
        />
        <div className="flex flex-col gap-2">
          <p className="text-sm text-zinc-600">Tally hash</p>
          <p className="font-mono text-4xl tracking-widest" data-testid="tally-hash-short">
            {shortHash(tally.tallyHash)}
          </p>
          <p className="font-mono text-xs break-all" data-testid="tally-hash-full">
            {tally.tallyHash}
          </p>
        </div>
      </section>

      <div className="print:hidden">
        <PrintButton />
      </div>
    </main>
  );
}
