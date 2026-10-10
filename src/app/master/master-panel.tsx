"use client";

import { useActionState, useState } from "react";
import { Button, Notice } from "@/components/ui";
import { useTerminalState } from "@/lib/signals/use-terminal-state";
import {
  boothTransitionAction,
  cancelBallotAction,
  confirmPairingAction,
  generateCodeAction,
  issueBallotAction,
  reauthenticateMasterAction,
  rejectPairingAction,
  type ActionResult,
  type BoothTransition,
  type CodeResult,
} from "./actions";
import {
  CancelDialog,
  ClearMockDialog,
  CloseDialog,
  MockResultDialog,
  OpenDialog,
} from "./dialogs";
import { LockOverlay, useIdleLock } from "./idle-lock";
import {
  actionOf,
  BallotButton,
  BoothHeader,
  Counters,
  Lamps,
  TerminalStatus,
  type MasterState,
} from "./terminal-parts";

/** The state changes with no signal when the Voting Terminal stops sending heartbeats. */
const STEADY_REFRESH_MS = 3_000;

type DialogName = "cancel" | "mock-result" | "clear-mock" | "open" | "close";

const controlButton =
  "h-14 rounded-lg px-5 text-lg font-medium disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400";

export function MasterPanel({ boothId }: { boothId: string }) {
  const { state, mode, unpaired, refresh } = useTerminalState<MasterState>({
    base: "/master/api",
    refreshEveryMs: STEADY_REFRESH_MS,
  });
  const { locked, unlock } = useIdleLock();
  const [dialog, setDialog] = useState<DialogName | null>(null);
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  // A Closed booth rejects every terminal credential, so after closing the poll the state
  // endpoint answers 401. Remember that this device closed it, to say so.
  const [closedHere, setClosedHere] = useState(false);

  // A dialog is never shown behind the lock (and is dropped on unlock).
  const visibleDialog = locked ? null : dialog;

  if (closedHere) {
    return (
      <div data-testid="poll-closed">
        <Notice tone="info">
          The poll at this booth is closed. This screen no longer controls the booth.
        </Notice>
      </div>
    );
  }
  if (unpaired) {
    return (
      <Notice tone="error">
        This device is no longer the Master Terminal (it was replaced, or the poll has closed).
        Reload the page to continue.
      </Notice>
    );
  }
  if (!state) return <p>Loading…</p>;

  const mock = state.boothState === "mock_poll";
  const action = (name: string) => actionOf(state, name);
  const issue = action("issue_ballot");
  const reauth = (password: string) => reauthenticateMasterAction(password);
  const transition = (name: BoothTransition, confirmation?: string) => () =>
    boothTransitionAction(boothId, name, confirmation);

  async function runTransition(name: BoothTransition) {
    if (transitioning) return;
    setTransitioning(true);
    setTransitionError(null);
    try {
      const result: ActionResult = await boothTransitionAction(boothId, name);
      if (!result.ok) setTransitionError(result.error);
      await refresh();
    } finally {
      setTransitioning(false);
    }
  }

  const showMockControls = ["setup", "mock_poll", "mock_cleared"].includes(state.boothState);

  return (
    <div
      data-testid="master-screen"
      data-mock={mock}
      className={`flex flex-col gap-5 rounded-2xl p-5 text-zinc-100 ${
        mock ? "bg-amber-950 ring-4 ring-amber-500" : "bg-zinc-800"
      } ${locked ? "pb-48" : ""}`}
    >
      {mock && (
        <p
          role="status"
          data-testid="mock-banner"
          className="rounded-md bg-amber-500 px-4 py-3 text-center text-xl font-bold tracking-widest text-black"
        >
          MOCK POLL: test ballots only, nothing here is a real vote
        </p>
      )}

      <BoothHeader state={state} />
      <TerminalStatus state={state} mode={mode} />
      <Counters state={state} />
      <Lamps ready={Boolean(issue?.allowed)} busy={state.ballotPending} />

      {/* Everything below is inert while locked: the state above stays readable. */}
      <div inert={locked} className="flex flex-col gap-5">
        <BallotButton
          allowed={Boolean(issue?.allowed)}
          reason={issue?.reason ?? null}
          locked={locked}
          send={() => issueBallotAction(boothId)}
          onDone={refresh}
        />

        {state.ballotPending && (
          <div>
            <button
              type="button"
              data-testid="cancel-ballot"
              disabled={!action("cancel_ballot")?.allowed}
              onClick={() => setDialog("cancel")}
              className={`${controlButton} bg-red-700 text-white`}
            >
              Cancel pending ballot
            </button>
          </div>
        )}

        {transitionError && <Notice tone="error">{transitionError}</Notice>}

        {showMockControls && (
          <section aria-label="Mock poll" className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">Mock poll</h2>
            <div className="flex flex-wrap gap-3">
              {state.boothState === "setup" && (
                <ControlButton
                  state={state}
                  busy={locked || transitioning}
                  name="start_mock_poll"
                  label="Start mock poll"
                  testId="start-mock"
                  onPress={() => void runTransition("start_mock_poll")}
                />
              )}
              {mock && (
                <>
                  <button
                    type="button"
                    data-testid="show-mock-result"
                    onClick={() => setDialog("mock-result")}
                    className={`${controlButton} bg-zinc-200 text-zinc-900`}
                  >
                    Mock result
                  </button>
                  <ControlButton
                    state={state}
                    busy={locked || transitioning}
                    name="clear_mock_poll"
                    label="Clear mock poll"
                    tone="danger"
                    testId="clear-mock"
                    onPress={() => setDialog("clear-mock")}
                  />
                </>
              )}
              {state.boothState === "mock_cleared" && (
                <ControlButton
                  state={state}
                  busy={locked || transitioning}
                  name="repeat_mock_poll"
                  label="Repeat mock poll"
                  testId="repeat-mock"
                  onPress={() => void runTransition("repeat_mock_poll")}
                />
              )}
            </div>
          </section>
        )}

        {(state.boothState === "mock_cleared" || state.boothState === "open") && (
          <section aria-label="Poll" className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">Poll</h2>
            <div className="flex flex-wrap gap-3">
              {state.boothState === "mock_cleared" && (
                <ControlButton
                  state={state}
                  busy={locked || transitioning}
                  name="open_poll"
                  label="Open poll"
                  testId="open-poll"
                  onPress={() => setDialog("open")}
                />
              )}
              {state.boothState === "open" && (
                <ControlButton
                  state={state}
                  busy={locked || transitioning}
                  name="close_poll"
                  label="Close poll"
                  tone="danger"
                  testId="close-poll"
                  onPress={() => setDialog("close")}
                />
              )}
            </div>
          </section>
        )}

        <section
          className="flex flex-col gap-3 rounded-lg bg-zinc-900 p-4 text-zinc-100"
          aria-label="Pair a Voting Terminal"
        >
          <PairingSection boothId={boothId} state={state} />
        </section>
      </div>

      {visibleDialog === "cancel" && (
        <CancelDialog
          onCancelBallot={(reason) => cancelBallotAction(boothId, reason)}
          onClose={() => setDialog(null)}
          onDone={refresh}
        />
      )}
      {visibleDialog === "mock-result" && (
        <MockResultDialog state={state} onClose={() => setDialog(null)} />
      )}
      {visibleDialog === "clear-mock" && (
        <ClearMockDialog
          clear={transition("clear_mock_poll")}
          onClose={() => setDialog(null)}
          onDone={refresh}
        />
      )}
      {visibleDialog === "open" && (
        <OpenDialog
          reauth={reauth}
          openPoll={transition("open_poll")}
          onClose={() => setDialog(null)}
          onDone={refresh}
        />
      )}
      {visibleDialog === "close" && (
        <CloseDialog
          state={state}
          reauth={reauth}
          closePoll={async (confirmation) => {
            const result = await transition("close_poll", confirmation)();
            if (result.ok) setClosedHere(true);
            return result;
          }}
          onClose={() => setDialog(null)}
          onDone={refresh}
        />
      )}

      {locked && (
        <LockOverlay
          reauth={reauth}
          onUnlock={() => {
            setDialog(null);
            unlock();
          }}
        />
      )}
    </div>
  );
}

function ControlButton(props: {
  state: MasterState;
  busy: boolean;
  name: string;
  label: string;
  tone?: "primary" | "danger";
  onPress: () => void;
  testId: string;
}) {
  const a = actionOf(props.state, props.name);
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        data-testid={props.testId}
        disabled={!a?.allowed || props.busy}
        onClick={props.onPress}
        className={`${controlButton} ${
          props.tone === "danger" ? "bg-red-700 text-white" : "bg-zinc-200 text-zinc-900"
        }`}
      >
        {props.label}
      </button>
      {!a?.allowed && a?.reason && (
        <p className="text-sm text-zinc-300" data-testid={`${props.testId}-reason`}>
          {a.reason}
        </p>
      )}
    </div>
  );
}

function PairingSection({ boothId, state }: { boothId: string; state: MasterState }) {
  const [generated, generate, generating] = useActionState<CodeResult, FormData>(
    generateCodeAction,
    null,
  );
  const vt = state.votingTerminal;
  const pending = state.pairing?.status === "pending" ? state.pairing : null;
  return (
    <>
      <h2 className="text-lg font-medium">
        {vt.paired ? "Replace the Voting Terminal" : "Pair a Voting Terminal"}
      </h2>
      {pending?.deviceId ? (
        <div
          className="flex flex-col gap-3 rounded-md border border-zinc-600 p-4"
          data-testid="pending-device"
        >
          <p>A device is asking to pair. Confirm that the kiosk shows this id:</p>
          <p className="font-mono text-4xl tracking-widest" data-testid="pending-device-id">
            {pending.deviceId}
          </p>
          <div className="flex gap-3">
            <form action={confirmPairingAction}>
              <input type="hidden" name="boothId" value={boothId} />
              <input type="hidden" name="codeId" value={pending.codeId} />
              <input type="hidden" name="deviceId" value={pending.deviceId} />
              <Button type="submit">Confirm</Button>
            </form>
            <form action={rejectPairingAction}>
              <input type="hidden" name="boothId" value={boothId} />
              <input type="hidden" name="codeId" value={pending.codeId} />
              <input type="hidden" name="deviceId" value={pending.deviceId} />
              <Button type="submit" variant="danger">
                Reject
              </Button>
            </form>
          </div>
        </div>
      ) : (
        <form action={generate} className="flex flex-col gap-3">
          <input type="hidden" name="boothId" value={boothId} />
          <div>
            <Button type="submit" disabled={generating}>
              Generate pairing code
            </Button>
          </div>
        </form>
      )}
      {generated && !generated.ok && <Notice tone="error">{generated.error}</Notice>}
      {generated?.ok && state.pairing?.status === "active" && (
        <div className="flex flex-wrap items-center gap-6" data-testid="pairing-code-panel">
          <p className="font-mono text-5xl tracking-widest" data-testid="pairing-code">
            {generated.code}
          </p>
          <div
            role="img"
            aria-label="QR code with the pairing link"
            className="h-48 w-48 bg-white p-1"
            dangerouslySetInnerHTML={{ __html: generated.qrSvg }}
          />
          <p className="text-sm text-zinc-300">
            Valid until {new Date(state.pairing.expiresAt).toLocaleTimeString()}. Single use.
          </p>
        </div>
      )}
    </>
  );
}
