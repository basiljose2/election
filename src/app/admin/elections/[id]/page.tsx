import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button, Field, first, Notice, PageShell } from "@/components/ui";
import { appendAuditEvent } from "@/lib/audit/append";
import { requireActorForPage } from "@/lib/auth/current-actor";
import { recordDeniedAttempt } from "@/lib/commands/gateway";
import { getPool } from "@/lib/db/pool";
import { candidateImageUrl } from "@/lib/media/store";
import { canConfigure, listElections, loadSetupView, type PostView } from "@/lib/setup/queries";
import {
  clearCandidateMediaAction,
  createBoothAction,
  createCandidateAction,
  createPostAction,
  deleteBoothAction,
  deleteCandidateAction,
  deletePostAction,
  freezeAction,
  reorderCandidatesAction,
  reorderPostsAction,
  setBoothPostsAction,
  setCandidateMediaAction,
  unfreezeAction,
  updateBoothAction,
  updateCandidateAction,
  updateElectionAction,
  updatePostAction,
} from "../actions";
import { SortableCandidates } from "./sortable-candidates";

export const metadata: Metadata = { title: "Election setup · Campus EVM" };

function Hidden({ electionId, ...rest }: { electionId: string } & Record<string, string>) {
  return (
    <>
      <input type="hidden" name="electionId" value={electionId} />
      {Object.entries(rest).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

/** Up/down buttons: the no-JavaScript equivalent of dragging. */
function moveOrder(ids: string[], id: string, delta: -1 | 1): string[] {
  const from = ids.indexOf(id);
  const to = from + delta;
  if (to < 0 || to >= ids.length) return ids;
  const next = [...ids];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

export default async function ElectionSetupPage({
  params,
  searchParams,
}: PageProps<"/admin/elections/[id]">) {
  const actor = await requireActorForPage();
  const { id: electionId } = await params;
  const query = await searchParams;

  if (!/^[0-9a-f-]{36}$/i.test(electionId)) notFound();
  const visible = await listElections(getPool(), actor);
  if (!visible.some((e) => e.id === electionId)) {
    await recordDeniedAttempt(
      { db: getPool(), appendAudit: appendAuditEvent },
      actor,
      "page.election_setup",
      { electionId, target: { type: "page", id: `/admin/elections/${electionId}` } },
    );
    return (
      <PageShell title="Not authorized">
        <Notice tone="error">You do not have access to this election.</Notice>
      </PageShell>
    );
  }

  const view = await loadSetupView(getPool(), electionId);
  if (!view) notFound();
  const { election, posts, booths, latestSnapshot } = view;
  const draft = election.status === "draft";
  const editable = draft && canConfigure(actor, electionId);
  const isRo = canConfigure(actor, electionId);
  const ok = first(query.ok);
  const error = first(query.error);
  const postName = new Map(posts.map((p) => [p.id, p.name]));

  return (
    <PageShell title={election.name}>
      <Link href="/admin/elections" className="text-sm underline">
        All elections
      </Link>
      {ok && <Notice tone="info">{ok}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <p className="text-sm text-zinc-600 dark:text-zinc-400" data-testid="election-status">
        Status: <strong>{election.status === "draft" ? "Draft" : "Frozen"}</strong> · polling{" "}
        {election.polling_date} · NOTA {election.nota_enabled ? "enabled" : "disabled"}
      </p>
      {!isRo && (
        <Notice tone="info">
          Only this election&apos;s Returning Officer can change its setup.
        </Notice>
      )}

      {/* ---------------------------------------------------------------- settings */}
      {editable && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-medium">Settings</h2>
          <form action={updateElectionAction} className="grid gap-3 sm:grid-cols-2">
            <Hidden electionId={electionId} />
            <Field label="Name" name="name" defaultValue={election.name} required />
            <Field
              label="Polling date"
              name="pollingDate"
              type="date"
              defaultValue={election.polling_date}
              required
            />
            <Field label="Description" name="description" defaultValue={election.description} />
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" name="notaEnabled" defaultChecked={election.nota_enabled} />{" "}
              Enable NOTA
            </label>
            <div>
              <Button type="submit" variant="plain">
                Save settings
              </Button>
            </div>
          </form>
        </section>
      )}

      {/* ------------------------------------------------------------------- posts */}
      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-medium">Posts and candidates</h2>
        {posts.length === 0 && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">No posts yet.</p>
        )}
        {posts.map((post) => (
          <PostCard
            key={post.id}
            post={post}
            postIds={posts.map((p) => p.id)}
            electionId={electionId}
            editable={editable}
            notaEnabled={election.nota_enabled}
          />
        ))}
        {editable && (
          <form
            action={createPostAction}
            className="grid items-end gap-3 sm:grid-cols-3"
            aria-label="Add post"
          >
            <Hidden electionId={electionId} />
            <Field label="New post name" name="name" required />
            <Field label="Seats" name="seats" type="number" min={1} defaultValue={1} required />
            <div>
              <Button type="submit">Add post</Button>
            </div>
          </form>
        )}
      </section>

      {/* ------------------------------------------------------------------ booths */}
      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-medium">Polling booths and mapping</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Each booth votes only on the posts ticked for it. Presiding Officers are assigned by a
          Super Admin (Manage staff).
        </p>
        {booths.length === 0 && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">No booths yet.</p>
        )}
        {booths.map((booth) => (
          <article
            key={booth.id}
            data-testid={`booth-${booth.name}`}
            className="flex flex-col gap-3 rounded-md border border-zinc-200 p-4 dark:border-zinc-800"
          >
            <header className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium">{booth.name}</p>
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  {booth.location} · Booth ID {booth.id} · Presiding Officer:{" "}
                  {booth.presiding_officer ?? "none assigned"}
                </p>
              </div>
            </header>
            <form action={setBoothPostsAction} className="flex flex-col gap-2">
              <Hidden electionId={electionId} boothId={booth.id} />
              <fieldset disabled={!editable} className="flex flex-wrap gap-4">
                <legend className="sr-only">Posts voted at {booth.name}</legend>
                {posts.map((post) => (
                  <label key={post.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="postIds"
                      value={post.id}
                      defaultChecked={booth.post_ids.includes(post.id)}
                    />
                    {post.name}
                  </label>
                ))}
              </fieldset>
              {editable && (
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" variant="plain">
                    Save mapping
                  </Button>
                </div>
              )}
            </form>
            {editable && (
              <div className="flex flex-wrap items-end gap-3">
                <form action={updateBoothAction} className="flex flex-wrap items-end gap-2">
                  <Hidden electionId={electionId} boothId={booth.id} />
                  <Field label="Name" name="name" defaultValue={booth.name} required />
                  <Field label="Location" name="location" defaultValue={booth.location} required />
                  <Button type="submit" variant="plain">
                    Rename booth
                  </Button>
                </form>
                <form action={deleteBoothAction}>
                  <Hidden electionId={electionId} boothId={booth.id} />
                  <Button type="submit" variant="danger">
                    Delete booth
                  </Button>
                </form>
              </div>
            )}
          </article>
        ))}
        {editable && (
          <form
            action={createBoothAction}
            className="grid items-end gap-3 sm:grid-cols-3"
            aria-label="Add booth"
          >
            <Hidden electionId={electionId} />
            <Field label="New booth name" name="name" required />
            <Field label="Location" name="location" required />
            <div>
              <Button type="submit">Add booth</Button>
            </div>
          </form>
        )}
      </section>

      {/* ------------------------------------------------------------------ freeze */}
      {isRo && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-medium">Freeze</h2>
          {draft ? (
            <>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                Freezing checks the whole setup, gives each booth its fixed ballot and publishes the
                Setup Hash. You will be asked to confirm your password and authentication code.
              </p>
              <form action={freezeAction}>
                <Hidden electionId={electionId} />
                <Button type="submit">Freeze setup</Button>
              </form>
            </>
          ) : (
            <>
              <p className="text-sm">
                Frozen. Setup Hash:{" "}
                <code data-testid="setup-hash" className="break-all">
                  {latestSnapshot?.setup_hash}
                </code>
              </p>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                You can return to Draft only if no Ballot Session (mock or real) has ever been
                issued.
              </p>
              <form action={unfreezeAction}>
                <Hidden electionId={electionId} />
                <Button type="submit" variant="plain">
                  Unfreeze
                </Button>
              </form>
            </>
          )}
        </section>
      )}
      {!isRo && !draft && latestSnapshot && (
        <p className="text-sm">
          Setup Hash:{" "}
          <code data-testid="setup-hash" className="break-all">
            {latestSnapshot.setup_hash}
          </code>
        </p>
      )}
      {!draft && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Uncontested posts:{" "}
          {posts
            .filter((p) => p.uncontested)
            .map((p) => postName.get(p.id))
            .join(", ") || "none"}
        </p>
      )}
    </PageShell>
  );
}

function PostCard({
  post,
  postIds,
  electionId,
  editable,
  notaEnabled,
}: {
  post: PostView;
  postIds: string[];
  electionId: string;
  editable: boolean;
  notaEnabled: boolean;
}) {
  const candidateIds = post.candidates.map((c) => c.id);
  return (
    <article
      data-testid={`post-${post.name}`}
      className="flex flex-col gap-3 rounded-md border border-zinc-200 p-4 dark:border-zinc-800"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">
            {post.name}
            {post.uncontested && " (uncontested)"}
          </p>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {post.seats} {post.seats === 1 ? "seat" : "seats"} · {post.candidates.length} candidate
            {post.candidates.length === 1 ? "" : "s"}
            {notaEnabled ? " · NOTA on the ballot" : ""}
          </p>
        </div>
        {editable && (
          <div className="flex flex-wrap gap-2">
            {(["up", "down"] as const).map((dir) => (
              <form key={dir} action={reorderPostsAction}>
                <Hidden electionId={electionId} />
                {moveOrder(postIds, post.id, dir === "up" ? -1 : 1).map((id) => (
                  <input key={id} type="hidden" name="orderedIds" value={id} />
                ))}
                <Button type="submit" variant="plain" aria-label={`Move ${post.name} ${dir}`}>
                  {dir === "up" ? "↑" : "↓"}
                </Button>
              </form>
            ))}
          </div>
        )}
      </header>

      {editable && (
        <div className="flex flex-wrap items-end gap-3">
          <form action={updatePostAction} className="flex flex-wrap items-end gap-2">
            <Hidden electionId={electionId} postId={post.id} />
            <Field label="Post name" name="name" defaultValue={post.name} required />
            <Field
              label="Seats"
              name="seats"
              type="number"
              min={1}
              defaultValue={post.seats}
              required
            />
            <Button type="submit" variant="plain">
              Save post
            </Button>
          </form>
          <form action={deletePostAction}>
            <Hidden electionId={electionId} postId={post.id} />
            <Button type="submit" variant="danger">
              Delete post
            </Button>
          </form>
        </div>
      )}

      {editable ? (
        <SortableCandidates
          electionId={electionId}
          postId={post.id}
          items={post.candidates.map((c) => ({ id: c.id, label: c.name }))}
          reorderAction={reorderCandidatesAction}
        />
      ) : (
        <ol className="list-decimal pl-6 text-sm">
          {post.candidates.map((c) => (
            <li key={c.id}>{c.name}</li>
          ))}
        </ol>
      )}

      {post.candidates.map((c) => (
        <div
          key={c.id}
          data-testid={`candidate-${c.name}`}
          className="flex flex-col gap-2 border-t border-zinc-200 pt-3 text-sm dark:border-zinc-800"
        >
          <div className="flex flex-wrap items-center gap-3">
            <strong>{c.name}</strong>
            {c.photo_hash && (
              // eslint-disable-next-line @next/next/no-img-element -- same-origin WebP already resized
              <img
                src={candidateImageUrl(c.photo_hash)}
                alt={`Photo of ${c.name}`}
                width={48}
                height={48}
              />
            )}
            {c.symbol_hash && (
              // eslint-disable-next-line @next/next/no-img-element -- same-origin WebP already resized
              <img
                src={candidateImageUrl(c.symbol_hash)}
                alt={`Symbol of ${c.name}`}
                width={32}
                height={32}
              />
            )}
            {c.symbol_text && <span>Symbol: {c.symbol_text}</span>}
          </div>
          {editable && (
            <>
              <div className="flex flex-wrap items-end gap-2">
                {candidateIds.length > 1 &&
                  (["up", "down"] as const).map((dir) => (
                    <form key={dir} action={reorderCandidatesAction}>
                      <Hidden electionId={electionId} postId={post.id} />
                      {moveOrder(candidateIds, c.id, dir === "up" ? -1 : 1).map((id) => (
                        <input key={id} type="hidden" name="orderedIds" value={id} />
                      ))}
                      <Button type="submit" variant="plain" aria-label={`Move ${c.name} ${dir}`}>
                        {dir === "up" ? "↑" : "↓"}
                      </Button>
                    </form>
                  ))}
                <form action={updateCandidateAction} className="flex flex-wrap items-end gap-2">
                  <Hidden electionId={electionId} candidateId={c.id} />
                  <Field label="Name" name="name" defaultValue={c.name} required />
                  <Field
                    label="Symbol text"
                    name="symbolText"
                    defaultValue={c.symbol_text ?? ""}
                    maxLength={40}
                  />
                  <Button type="submit" variant="plain">
                    Save candidate
                  </Button>
                </form>
                <form action={deleteCandidateAction}>
                  <Hidden electionId={electionId} candidateId={c.id} />
                  <Button type="submit" variant="danger">
                    Delete
                  </Button>
                </form>
              </div>
              <div className="flex flex-wrap items-end gap-4">
                {(["photo", "symbol"] as const).map((kind) => (
                  <form
                    key={kind}
                    action={setCandidateMediaAction}
                    encType="multipart/form-data"
                    className="flex flex-wrap items-end gap-2"
                  >
                    <Hidden electionId={electionId} candidateId={c.id} kind={kind} />
                    <label className="flex flex-col gap-1 text-sm font-medium">
                      {kind === "photo" ? "Photo" : "Symbol image"} (PNG, JPEG or WebP, max 2 MB)
                      <input
                        type="file"
                        name="file"
                        accept="image/png,image/jpeg,image/webp"
                        aria-label={`${kind === "photo" ? "Photo" : "Symbol image"} for ${c.name}`}
                        required
                      />
                    </label>
                    <Button type="submit" variant="plain">
                      Upload
                    </Button>
                  </form>
                ))}
                {(c.photo_hash || c.symbol_hash) && (
                  <form action={clearCandidateMediaAction} className="flex gap-2">
                    <Hidden
                      electionId={electionId}
                      candidateId={c.id}
                      kind={c.photo_hash ? "photo" : "symbol"}
                    />
                    <Button type="submit" variant="plain">
                      Remove {c.photo_hash ? "photo" : "symbol image"}
                    </Button>
                  </form>
                )}
              </div>
            </>
          )}
        </div>
      ))}

      {editable && (
        <form action={createCandidateAction} className="flex flex-wrap items-end gap-2">
          <Hidden electionId={electionId} postId={post.id} />
          <Field label={`New candidate for ${post.name}`} name="name" required />
          <Field label="Symbol text (optional)" name="symbolText" maxLength={40} />
          <Button type="submit">Add candidate</Button>
        </form>
      )}
    </article>
  );
}
