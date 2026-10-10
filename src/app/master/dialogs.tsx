"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { CANCEL_REASON_LABELS, CANCEL_REASONS } from "@/lib/commands/cancel-reasons";
import type { MockCounts } from "@/lib/votes/mock-counts";
import type { ActionResult } from "./actions";
import type { MasterState } from "./terminal-parts";

type Send = () => Promise<ActionResult>;

const buttonBase = "h-12 rounded-md px-5 text-base font-medium disabled:cursor-not-allowed";
const primary = `${buttonBase} bg-zinc-100 text-zinc-900 disabled:bg-zinc-600 disabled:text-zinc-400`;
const danger = `${buttonBase} bg-red-700 text-white disabled:bg-zinc-600 disabled:text-zinc-400`;
const plain = `${buttonBase} border border-zinc-500 text-zinc-100`;
const input =
  "h-12 w-full rounded-md border border-zinc-500 bg-zinc-950 px-3 text-base text-zinc-100";

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="master-dialog-title"
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        className="flex max-h-full w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-xl border border-zinc-600 bg-zinc-800 p-6 text-zinc-100"
      >
        <h2
          id="master-dialog-title"
          ref={heading}
          tabIndex={-1}
          className="text-xl font-semibold outline-none"
        >
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="rounded-md bg-red-950 px-3 py-2 text-sm text-red-200">
      {error}
    </p>
  ) : null;
}

/** Runs `work`, ignoring a second call while one is in flight. */
function useSubmit(onSuccess: () => Promise<void> | void) {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(work: Send) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await work();
      if (!result.ok) setError(result.error);
      else await onSuccess();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return { busy, error, submit };
}

// ---- Cancel ----------------------------------------------------------------------------------

export function CancelDialog({
  onCancelBallot,
  onClose,
  onDone,
}: {
  onCancelBallot: (reason: string) => Promise<ActionResult>;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const { busy, error, submit } = useSubmit(async () => {
    await onDone();
    onClose();
  });
  return (
    <Modal title="Cancel the pending ballot" onClose={onClose}>
      <p className="text-sm text-zinc-300">
        The voter&apos;s screen locks and no vote is recorded. Choose why the ballot is being
        cancelled.
      </p>
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Reason</legend>
        {CANCEL_REASONS.map((value) => (
          <label key={value} className="flex items-center gap-3 text-base">
            <input
              type="radio"
              name="cancel-reason"
              value={value}
              checked={reason === value}
              onChange={() => setReason(value)}
              className="h-5 w-5"
            />
            {CANCEL_REASON_LABELS[value]}
          </label>
        ))}
      </fieldset>
      <ErrorLine error={error} />
      <div className="flex justify-end gap-3">
        <button type="button" className={plain} onClick={onClose} disabled={busy}>
          Keep ballot
        </button>
        <button
          type="button"
          className={danger}
          disabled={!reason || busy}
          onClick={() => submit(() => onCancelBallot(reason))}
        >
          Cancel ballot
        </button>
      </div>
    </Modal>
  );
}

// ---- Open and close --------------------------------------------------------------------------

function PasswordField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-sm font-medium">
      Your password (to confirm it is you)
      <input
        type="password"
        autoComplete="current-password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={input}
      />
    </label>
  );
}

/** Re-authenticates, then runs the critical action. Stops at the first failure. */
async function afterReauth(
  reauth: (password: string) => Promise<ActionResult>,
  password: string,
  action: Send,
): Promise<ActionResult> {
  const fresh = await reauth(password);
  return fresh.ok ? action() : fresh;
}

export function OpenDialog({
  reauth,
  openPoll,
  onClose,
  onDone,
}: {
  reauth: (password: string) => Promise<ActionResult>;
  openPoll: Send;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const { busy, error, submit } = useSubmit(async () => {
    await onDone();
    onClose();
  });
  return (
    <Modal title="Open the poll" onClose={onClose}>
      <p>
        Opening the poll starts the real count. The real ballot count is{" "}
        <strong data-testid="open-count">0</strong>: nothing from the mock poll is carried over.
      </p>
      <PasswordField value={password} onChange={setPassword} />
      <ErrorLine error={error} />
      <div className="flex justify-end gap-3">
        <button type="button" className={plain} onClick={onClose} disabled={busy}>
          Not yet
        </button>
        <button
          type="button"
          className={primary}
          disabled={!password || busy}
          onClick={() => submit(() => afterReauth(reauth, password, openPoll))}
        >
          Confirm: open the poll
        </button>
      </div>
    </Modal>
  );
}

export function CloseDialog({
  state,
  reauth,
  closePoll,
  onClose,
  onDone,
}: {
  state: MasterState;
  reauth: (password: string) => Promise<ActionResult>;
  closePoll: (confirmation: string) => Promise<ActionResult>;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [typed, setTyped] = useState("");
  const { busy, error, submit } = useSubmit(async () => {
    await onDone();
    onClose();
  });
  return (
    <Modal title="Close the poll" onClose={onClose}>
      <p>Closing the poll ends voting at this booth. It cannot be reopened.</p>
      <dl className="grid grid-cols-2 gap-2 rounded-md bg-zinc-900 p-3 text-sm">
        <dt>Ballots cast</dt>
        <dd className="font-mono" data-testid="close-count-cast">
          {state.ballotsCast}
        </dd>
        <dt>Ballots cancelled</dt>
        <dd className="font-mono" data-testid="close-count-cancelled">
          {state.ballotsCancelled}
        </dd>
      </dl>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Type CLOSE to confirm
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          className={input}
        />
      </label>
      <PasswordField value={password} onChange={setPassword} />
      <ErrorLine error={error} />
      <div className="flex justify-end gap-3">
        <button type="button" className={plain} onClick={onClose} disabled={busy}>
          Keep polling
        </button>
        <button
          type="button"
          className={danger}
          disabled={typed !== "CLOSE" || !password || busy}
          onClick={() => submit(() => afterReauth(reauth, password, () => closePoll(typed)))}
        >
          Confirm: close the poll
        </button>
      </div>
    </Modal>
  );
}

// ---- Mock poll -------------------------------------------------------------------------------

/** The current mock round's counts: the only per-candidate data this screen ever requests. */
function useMockCounts(refetchKey: number) {
  const [counts, setCounts] = useState<MockCounts | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/master/api/mock-counts", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("mock counts");
        const body = (await response.json()) as MockCounts;
        if (!cancelled) setCounts(body);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [refetchKey]);
  return { counts, failed };
}

function MockTable({ counts }: { counts: MockCounts | null }) {
  if (!counts) return <p className="text-sm text-zinc-300">Loading the mock result…</p>;
  const posts = new Map<string, { name: string; options: MockCounts["options"] }>();
  for (const option of counts.options) {
    const post = posts.get(option.postId) ?? { name: option.postName, options: [] };
    post.options.push(option);
    posts.set(option.postId, post);
  }
  return (
    <div className="flex flex-col gap-3" data-testid="mock-result">
      <p>
        Mock ballots this round:{" "}
        <strong className="font-mono" data-testid="mock-total">
          {counts.mockBallots}
        </strong>
      </p>
      {[...posts.entries()].map(([postId, post]) => (
        <table key={postId} className="w-full text-left text-sm">
          <caption className="pb-1 text-left font-semibold">{post.name}</caption>
          <tbody>
            {post.options.map((o) => (
              <tr key={o.candidateId ?? "nota"} className="border-t border-zinc-600">
                <td className="py-1">{o.name}</td>
                <td className="py-1 text-right font-mono tabular-nums">{o.votes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </div>
  );
}

export function MockResultDialog({ state, onClose }: { state: MasterState; onClose: () => void }) {
  const { counts, failed } = useMockCounts(state.mock.ballotsCast);
  return (
    <Modal title="Mock result" onClose={onClose}>
      <p className="rounded-md bg-amber-900/60 px-3 py-2 text-sm">
        MOCK POLL: test ballots only. These are not real votes.
      </p>
      {failed ? (
        <ErrorLine error="The mock result could not be loaded." />
      ) : (
        <MockTable counts={counts} />
      )}
      <div className="flex justify-end">
        <button type="button" className={plain} onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

export function ClearMockDialog({
  clear,
  onClose,
  onDone,
}: {
  clear: Send;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { counts, failed } = useMockCounts(0);
  const { busy, error, submit } = useSubmit(async () => {
    await onDone();
    onClose();
  });
  return (
    <Modal title="Clear the mock poll" onClose={onClose}>
      <p className="text-sm text-zinc-300">
        Clearing removes the mock ballots from every count. The totals below are recorded in the
        audit log.
      </p>
      {failed ? (
        <ErrorLine error="The mock result could not be loaded." />
      ) : (
        <MockTable counts={counts} />
      )}
      <ErrorLine error={error} />
      <div className="flex justify-end gap-3">
        <button type="button" className={plain} onClick={onClose} disabled={busy}>
          Keep mock poll
        </button>
        <button
          type="button"
          className={danger}
          disabled={!counts || busy}
          onClick={() => submit(clear)}
        >
          Confirm: clear mock poll
        </button>
      </div>
    </Modal>
  );
}
