import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageShell } from "@/components/ui";
import { getPool } from "@/lib/db/pool";
import { getPublicResult, getPublicSetup, getPublicTallies } from "@/lib/transparency/public-data";

export const metadata: Metadata = { title: "Election · Campus EVM" };

const mediaUrl = (hash: string) => `/media/candidates/${hash}`;

/** The public face of an Election: exactly what was frozen, with the hashes to check it by. */
export default async function PublicElectionPage({ params }: PageProps<"/public/elections/[id]">) {
  const { id } = await params;
  const setup = await getPublicSetup(getPool(), id);
  // A Draft (or unknown) Election does not exist as far as the public is concerned.
  if (!setup) notFound();

  const [tallies, result] = await Promise.all([
    getPublicTallies(getPool(), id),
    getPublicResult(getPool(), id),
  ]);
  const postName = new Map(setup.posts.map((p) => [p.id, p.name]));

  return (
    <PageShell title={setup.election.name}>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{setup.election.description}</p>
      <nav className="flex flex-wrap gap-4 text-sm" aria-label="This election">
        <Link
          className="underline"
          href={`/public/elections/${id}/status`}
          data-testid="link-status"
        >
          Live status
        </Link>
        {result && (
          <>
            <Link
              className="underline"
              href={`/public/elections/${id}/results`}
              data-testid="link-results"
            >
              Results
            </Link>
            <a
              className="underline"
              href={`/public/elections/${id}/bundle`}
              data-testid="link-bundle"
            >
              Verification bundle (zip)
            </a>
            <Link className="underline" href="/verify">
              Verify a bundle
            </Link>
          </>
        )}
      </nav>

      <section className="flex flex-col gap-2" aria-label="Integrity">
        <h2 className="text-lg font-medium">What was frozen</h2>
        <dl className="grid gap-1 text-sm">
          <dt className="font-medium">Setup Hash (SHA-256 of the frozen setup)</dt>
          <dd className="font-mono break-all" data-testid="setup-hash">
            {setup.setupHash}
          </dd>
          <dt className="font-medium">Public signing key (Ed25519)</dt>
          <dd className="font-mono break-all" data-testid="public-key">
            {setup.publicKey}
          </dd>
          <dt className="font-medium">NOTA</dt>
          <dd>{setup.election.notaEnabled ? "Enabled" : "Disabled"}</dd>
        </dl>
        <a className="text-sm underline" href={`/api/elections/${id}/setup`}>
          The frozen setup as hashed (JSON)
        </a>
      </section>

      <section className="flex flex-col gap-4" aria-label="Posts">
        <h2 className="text-lg font-medium">Posts and candidates</h2>
        {setup.posts.map((post) => (
          <div
            key={post.id}
            className="rounded-md border border-zinc-300 p-4 dark:border-zinc-700"
            data-testid={`post-${post.id}`}
          >
            <h3 className="font-medium">
              {post.name}{" "}
              <span className="text-sm font-normal text-zinc-600 dark:text-zinc-400">
                · {post.seats} seat{post.seats === 1 ? "" : "s"}
                {post.uncontested ? " · uncontested" : ""}
              </span>
            </h3>
            <ol className="mt-2 flex flex-col gap-2">
              {post.candidates.map((c) => (
                <li key={c.id} className="flex items-center gap-3 text-sm">
                  <span className="w-6 text-right tabular-nums">{c.serial ?? "-"}</span>
                  {c.photoHash ? (
                    // eslint-disable-next-line @next/next/no-img-element -- public static media
                    <img
                      src={mediaUrl(c.photoHash)}
                      alt=""
                      className="h-10 w-10 rounded object-cover"
                    />
                  ) : (
                    <span className="h-10 w-10" />
                  )}
                  <span className="flex-1">{c.name}</span>
                  {c.symbolHash ? (
                    // eslint-disable-next-line @next/next/no-img-element -- public static media
                    <img src={mediaUrl(c.symbolHash)} alt="" className="h-10 w-10 object-contain" />
                  ) : (
                    <span>{c.symbolText}</span>
                  )}
                </li>
              ))}
              {setup.election.notaEnabled && !post.uncontested && (
                <li className="text-sm">NOTA (None of the above)</li>
              )}
            </ol>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-3" aria-label="Booths">
        <h2 className="text-lg font-medium">Polling booths and their ballots</h2>
        <ul className="flex flex-col gap-3">
          {setup.booths.map((b) => (
            <li
              key={b.id}
              className="rounded-md border border-zinc-300 p-4 text-sm dark:border-zinc-700"
              data-testid={`booth-${b.id}`}
            >
              <p className="font-medium">
                {b.name}{" "}
                <span className="font-normal text-zinc-600 dark:text-zinc-400">· {b.location}</span>
              </p>
              <p>Votes on: {b.postIds.map((pid) => postName.get(pid) ?? pid).join(", ")}</p>
              <p className="font-mono text-xs break-all">
                Ballot Definition hash: {b.definitionHash}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-3" aria-label="Booth Tallies">
        <h2 className="text-lg font-medium">Booth Tallies</h2>
        {tallies.length === 0 ? (
          <p className="text-sm">No booth has closed yet.</p>
        ) : (
          <table className="w-full text-left text-sm" data-testid="tallies">
            <thead>
              <tr className="border-b border-zinc-300 dark:border-zinc-700">
                <th className="py-2">Booth</th>
                <th>Cast</th>
                <th>Cancelled</th>
                <th>Status</th>
                <th>Tally hash</th>
                <th>Merkle root</th>
              </tr>
            </thead>
            <tbody>
              {tallies.map((t) => (
                <tr
                  key={t.boothId}
                  className="border-b border-zinc-200 align-top dark:border-zinc-800"
                  data-testid={`tally-${t.boothId}`}
                >
                  <td className="py-1">{t.boothName}</td>
                  <td className="tabular-nums">{t.ballotsCast}</td>
                  <td className="tabular-nums">{t.ballotsCancelled}</td>
                  <td>{t.status === "pass" ? "PASS" : "FAILED"}</td>
                  <td className="font-mono text-xs break-all" data-testid="tally-hash">
                    {t.tallyHash}
                  </td>
                  <td className="font-mono text-xs break-all">{t.merkleRoot}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </PageShell>
  );
}
