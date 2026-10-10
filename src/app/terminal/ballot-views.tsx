"use client";

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import {
  isPostComplete,
  postHint,
  type BallotCandidate,
  type BallotPost,
  type BoothBallot,
  type Selection,
} from "./ballot-model";
import { STRINGS } from "./strings";

const mediaUrl = (hash: string) => `/media/candidates/${hash}`;

const buttonBase =
  "min-h-16 min-w-32 rounded-full px-8 text-xl font-semibold disabled:cursor-not-allowed disabled:opacity-50";
const primaryButton = `${buttonBase} bg-blue-800 text-white`;
const quietButton = `${buttonBase} border-2 border-zinc-600 bg-white text-zinc-900`;

/** Arrow keys move between the screen's buttons (Tab and Enter work natively). */
function onArrowKeys(event: KeyboardEvent<HTMLElement>) {
  const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
  const backward = event.key === "ArrowUp" || event.key === "ArrowLeft";
  if (!forward && !backward) return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-nav]")].filter(
    (el) => !(el as HTMLButtonElement).disabled,
  );
  if (items.length === 0) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = forward ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
  event.preventDefault();
  items[next]?.focus();
}

function Panel({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section
      aria-label={label}
      onKeyDown={onArrowKeys}
      className="mx-auto flex w-full max-w-4xl flex-col gap-4 rounded-2xl border-4 border-zinc-500 bg-zinc-200 p-5 text-zinc-900"
    >
      {children}
    </section>
  );
}

/** Moves focus to the heading when the screen changes, so keyboard users start at the top. */
function useFocusHeading() {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return ref;
}

function Lamp({ lit, testId }: { lit: boolean; testId: string }) {
  return (
    <span
      aria-hidden
      data-testid={testId}
      data-lit={lit}
      className={`h-8 w-8 shrink-0 rounded-full border-2 border-zinc-700 ${
        lit ? "bg-red-600 shadow-[0_0_18px_#dc2626]" : "bg-zinc-400"
      }`}
    />
  );
}

function Row({
  serial,
  name,
  photoHash,
  symbolHash,
  symbolText,
  selected,
  onSelect,
  rowId,
}: {
  serial: number | null;
  name: string;
  photoHash?: string | null;
  symbolHash?: string | null;
  symbolText?: string | null;
  selected: boolean;
  onSelect: () => void;
  rowId: string;
}) {
  return (
    <li
      data-testid={`row-${rowId}`}
      className="flex min-h-20 items-center gap-4 rounded-xl bg-zinc-50 p-3"
    >
      <span className="w-10 text-center text-2xl font-bold" aria-label={STRINGS.serial}>
        {serial}
      </span>
      <span className="flex h-16 w-16 shrink-0 items-center justify-center">
        {photoHash && (
          // eslint-disable-next-line @next/next/no-img-element -- kiosk preloads these itself
          <img src={mediaUrl(photoHash)} alt="" className="h-16 w-16 rounded-md object-cover" />
        )}
      </span>
      <span className="flex-1 text-2xl font-medium">{name}</span>
      <span className="flex h-16 w-20 shrink-0 items-center justify-center text-lg font-semibold">
        {symbolHash ? (
          // eslint-disable-next-line @next/next/no-img-element -- kiosk preloads these itself
          <img src={mediaUrl(symbolHash)} alt="" className="h-16 w-16 object-contain" />
        ) : (
          symbolText
        )}
      </span>
      <Lamp lit={selected} testId={`lamp-${rowId}`} />
      <button
        type="button"
        data-nav
        data-testid={`select-${rowId}`}
        aria-pressed={selected}
        aria-label={STRINGS.select(name)}
        onClick={onSelect}
        className="h-16 w-28 shrink-0 rounded-full bg-blue-800 text-lg font-semibold text-white aria-pressed:ring-4 aria-pressed:ring-blue-300"
      >
        {selected ? "✓" : ""}
      </button>
    </li>
  );
}

export function PostScreen({
  ballot,
  post,
  index,
  selection,
  notice,
  fromReview,
  onCandidate,
  onNota,
  onNext,
  onBack,
}: {
  ballot: BoothBallot;
  post: BallotPost;
  index: number;
  selection: Selection;
  notice: string | null;
  fromReview: boolean;
  onCandidate: (candidate: BallotCandidate) => void;
  onNota: () => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const heading = useFocusHeading();
  const complete = isPostComplete(post, selection);
  const last = index === ballot.posts.length - 1;
  return (
    <Panel label={post.name}>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 ref={heading} tabIndex={-1} className="text-3xl font-bold outline-none">
          {post.name}
        </h1>
        <p className="text-lg" data-testid="post-progress">
          {STRINGS.postOf(index + 1, ballot.posts.length)}
        </p>
      </header>
      <p className="text-xl font-medium" data-testid="post-instruction">
        {STRINGS.selectExactly(post.seats)}
      </p>

      <ul className="flex flex-col gap-3">
        {post.candidates.map((candidate) => (
          <Row
            key={candidate.id}
            rowId={candidate.id}
            serial={candidate.serial}
            name={candidate.name}
            photoHash={candidate.photo_hash}
            symbolHash={candidate.symbol_hash}
            symbolText={candidate.symbol_text}
            selected={selection.candidateIds.includes(candidate.id)}
            onSelect={() => onCandidate(candidate)}
          />
        ))}
        {ballot.nota_enabled && (
          <Row
            rowId="nota"
            serial={post.nota_serial}
            name={STRINGS.nota}
            selected={selection.nota}
            onSelect={onNota}
          />
        )}
      </ul>

      <p
        role="status"
        data-testid="post-hint"
        className={`min-h-8 text-xl font-medium ${notice ? "text-red-800" : ""}`}
      >
        {notice ?? postHint(post, selection)}
      </p>

      <div className="flex justify-between gap-4">
        <button
          type="button"
          data-nav
          className={quietButton}
          onClick={onBack}
          disabled={fromReview || index === 0}
        >
          {STRINGS.back}
        </button>
        <button
          type="button"
          data-nav
          data-testid="next"
          className={primaryButton}
          onClick={onNext}
          disabled={!complete}
        >
          {last || fromReview ? STRINGS.review : STRINGS.next}
        </button>
      </div>
    </Panel>
  );
}

function chosenNames(post: BallotPost, selection: Selection): string {
  if (selection.nota) return STRINGS.nota;
  return post.candidates
    .filter((c) => selection.candidateIds.includes(c.id))
    .map((c) => c.name)
    .join(", ");
}

export function ReviewScreen({
  ballot,
  selections,
  onChange,
  onCast,
}: {
  ballot: BoothBallot;
  selections: Record<string, Selection>;
  onChange: (index: number) => void;
  onCast: () => void;
}) {
  const heading = useFocusHeading();
  return (
    <Panel label={STRINGS.reviewTitle}>
      <h1 ref={heading} tabIndex={-1} className="text-3xl font-bold outline-none">
        {STRINGS.reviewTitle}
      </h1>
      <ul className="flex flex-col gap-3">
        {ballot.posts.map((post, index) => (
          <li
            key={post.post_id}
            data-testid={`review-${post.post_id}`}
            className="flex min-h-20 items-center gap-4 rounded-xl bg-zinc-50 p-3"
          >
            <div className="flex-1">
              <p className="text-lg font-semibold">{post.name}</p>
              <p className="text-2xl">
                {chosenNames(post, selections[post.post_id] ?? { candidateIds: [], nota: false })}
              </p>
            </div>
            <button
              type="button"
              data-nav
              aria-label={STRINGS.change(post.name)}
              className={quietButton}
              onClick={() => onChange(index)}
            >
              {STRINGS.changeShort}
            </button>
          </li>
        ))}
      </ul>
      <div className="flex justify-end">
        <button
          type="button"
          data-nav
          data-testid="cast"
          className={`${primaryButton} min-h-20 px-12 text-2xl`}
          onClick={onCast}
        >
          {STRINGS.castMyVote}
        </button>
      </div>
    </Panel>
  );
}

export function MessageScreen({
  testId,
  title,
  detail,
}: {
  testId: string;
  title: string;
  detail?: string;
}) {
  return (
    <main
      className="flex min-h-screen flex-col items-center justify-center gap-4 bg-zinc-100 p-8 text-center text-zinc-900"
      data-testid={testId}
    >
      <h1 className="text-4xl font-semibold" role="status">
        {title}
      </h1>
      {detail && <p className="text-xl">{detail}</p>}
    </main>
  );
}
