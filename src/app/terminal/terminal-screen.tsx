"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useTerminalState } from "@/lib/signals/use-terminal-state";
import { createAudioContext, playTone, TEST_TONE, VOTE_BEEP } from "./audio";
import { ballotReducer, buildAnswers, initialBallotState, type BoothBallot } from "./ballot-model";
import { CastingScreen, MessageScreen, PostScreen, ReviewScreen } from "./ballot-views";
import { castWithRetry, sleep } from "./cast";
import { useFullscreenGuard, useKioskProtections, useWakeLock } from "./kiosk";
import { STRINGS } from "./strings";

interface VotingState {
  role: "voting";
  version: number;
  boothState: string;
  ballotPending: boolean;
}

/** How long "Your vote has been recorded" stays before the terminal locks again. */
export const RECORDED_MESSAGE_MS = 3_000;

/** Images already requested; keeping the elements alive keeps them in the memory cache. */
const preloaded = new Map<string, HTMLImageElement>();

function preloadImages(ballot: BoothBallot) {
  for (const post of ballot.posts) {
    for (const candidate of post.candidates) {
      for (const hash of [candidate.photo_hash, candidate.symbol_hash]) {
        if (!hash || preloaded.has(hash)) continue;
        const image = new Image();
        image.src = `/media/candidates/${hash}`;
        preloaded.set(hash, image);
      }
    }
  }
}

/**
 * The voter-facing Ballot Unit. The server decides everything that matters: the screen is
 * locked unless the server reports a pending Ballot Session AND this terminal has been
 * activated, and choices live only in the reducer's memory until they are cast.
 */
export function VotingTerminalScreen() {
  const router = useRouter();
  const { state, mode, unpaired } = useTerminalState<VotingState>({ base: "/terminal/api" });
  const [ballot, dispatch] = useReducer(ballotReducer, initialBallotState);
  const [activated, setActivated] = useState(false);
  const audio = useRef<AudioContext | null>(null);
  const fetchedFor = useRef<number | null>(null);
  const definitionFor = useRef<number | null>(null);

  useKioskProtections(activated);
  useWakeLock(activated);
  const fullscreen = useFullscreenGuard(activated);

  useEffect(() => {
    if (unpaired) router.replace("/terminal/pair");
  }, [unpaired, router]);

  const activate = useCallback(async () => {
    // Everything here must happen inside the tap: fullscreen and audio both need the gesture.
    audio.current ??= createAudioContext();
    try {
      await document.documentElement.requestFullscreen?.();
    } catch {
      // The fullscreen guard shows its overlay until the browser allows it.
    }
    if (audio.current) void playTone(audio.current, TEST_TONE);
    setActivated(true);
  }, []);

  // Preload the Ballot Definition (public after freeze) and its images while the terminal is
  // idle, and again whenever the state version changes.
  const idle = ballot.phase.kind === "locked";
  const version = state?.version ?? null;
  useEffect(() => {
    if (!activated || !idle || version === null || definitionFor.current === version) return;
    definitionFor.current = version;
    void fetch("/terminal/api/definition", { cache: "no-store" })
      .then((response) => (response.ok ? (response.json() as Promise<BoothBallot>) : null))
      .then((definition) => definition && preloadImages(definition))
      .catch(() => undefined);
  }, [activated, idle, version]);

  // A pending Ballot Session unlocks the terminal; losing it mid-ballot discards the choices.
  const pending = state?.ballotPending ?? false;
  const phaseKind = ballot.phase.kind;
  useEffect(() => {
    if (!activated || version === null) return;
    if (phaseKind === "locked" && pending && fetchedFor.current !== version) {
      fetchedFor.current = version;
      void fetch("/terminal/api/ballot", { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then(
          (body: { status: string; castToken?: string; ballotDefinition?: BoothBallot } | null) => {
            if (body?.status !== "pending" || !body.castToken || !body.ballotDefinition) return;
            preloadImages(body.ballotDefinition);
            dispatch({
              type: "unlock",
              ballot: body.ballotDefinition,
              castToken: body.castToken,
            });
          },
        )
        .catch(() => {
          // Try again on the next state version.
          fetchedFor.current = null;
        });
    }
    if (!pending && (phaseKind === "post" || phaseKind === "review")) {
      dispatch({ type: "lock", notice: STRINGS.cancelled });
    }
  }, [activated, pending, phaseKind, version]);

  // Casting: the same idempotency key is retried until the server gives a definitive answer.
  // Nothing else changes the state while casting, so this effect runs once per ballot.
  useEffect(() => {
    const { phase, castToken, idempotencyKey } = ballot;
    if (phase.kind !== "casting" || !castToken || !idempotencyKey) return;
    const controller = new AbortController();
    void castWithRetry(
      { castToken, idempotencyKey, answers: buildAnswers(ballot) },
      { fetch: (...args) => fetch(...args), sleep, signal: controller.signal },
    ).then((outcome) => {
      if (outcome.kind === "recorded") {
        // The beep only ever follows a recorded vote.
        if (audio.current) void playTone(audio.current, VOTE_BEEP);
        dispatch({ type: "recorded" });
      } else if (outcome.kind === "cancelled") {
        dispatch({ type: "lock", notice: STRINGS.cancelled });
      } else if (outcome.kind === "refused") {
        dispatch({ type: "lock", notice: STRINGS.notRecorded });
      }
    });
    return () => controller.abort();
  }, [ballot]);

  // "Your vote has been recorded" stays for 3 seconds, then the terminal locks again.
  const recorded = phaseKind === "recorded";
  useEffect(() => {
    if (!recorded) return;
    const timer = setTimeout(() => dispatch({ type: "lock" }), RECORDED_MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [recorded]);

  if (!activated) {
    return (
      <main
        className="flex min-h-screen flex-col items-center justify-center gap-6 bg-zinc-100 p-8 text-center text-zinc-900"
        data-testid="terminal-not-activated"
      >
        <h1 className="text-4xl font-semibold">{STRINGS.notActivated}</h1>
        <p className="text-xl">{STRINGS.notActivatedHelp}</p>
        <button
          type="button"
          data-testid="activate"
          onClick={() => void activate()}
          className="min-h-20 rounded-full bg-blue-800 px-12 text-2xl font-semibold text-white"
        >
          {STRINGS.activate}
        </button>
      </main>
    );
  }

  const { phase, ballot: definition } = ballot;
  let screen;
  if (phase.kind === "post" && definition) {
    const post = definition.posts[phase.index]!;
    screen = (
      <main data-testid="terminal-unlocked" className="min-h-screen bg-zinc-100 p-4">
        <PostScreen
          ballot={definition}
          post={post}
          index={phase.index}
          selection={ballot.selections[post.post_id] ?? { candidateIds: [], nota: false }}
          notice={ballot.notice}
          fromReview={phase.fromReview}
          onCandidate={(candidate) =>
            dispatch({ type: "toggle-candidate", postId: post.post_id, candidateId: candidate.id })
          }
          onNota={() => dispatch({ type: "toggle-nota", postId: post.post_id })}
          onNext={() => dispatch({ type: "next" })}
          onBack={() => dispatch({ type: "back" })}
        />
      </main>
    );
  } else if (phase.kind === "review" && definition) {
    screen = (
      <main data-testid="terminal-unlocked" className="min-h-screen bg-zinc-100 p-4">
        <ReviewScreen
          ballot={definition}
          selections={ballot.selections}
          onChange={(index) => dispatch({ type: "change", index })}
          onCast={() => dispatch({ type: "cast", idempotencyKey: crypto.randomUUID() })}
        />
      </main>
    );
  } else if (phase.kind === "casting") {
    screen = <CastingScreen />;
  } else if (phase.kind === "recorded") {
    screen = <MessageScreen testId="terminal-recorded" title={STRINGS.recorded} />;
  } else {
    screen = (
      <main
        className="flex min-h-screen flex-col items-center justify-center gap-6 bg-zinc-100 p-8 text-center text-zinc-900"
        data-testid="terminal-locked"
      >
        <h1 className="text-4xl font-semibold">{STRINGS.locked}</h1>
        {ballot.lockedNotice && (
          <p role="status" className="text-xl" data-testid="terminal-notice">
            {ballot.lockedNotice}
          </p>
        )}
        <p className="text-sm text-zinc-600" data-testid="terminal-connection">
          {mode === "realtime"
            ? STRINGS.connected
            : mode === "polling"
              ? STRINGS.reconnecting
              : STRINGS.connecting}
        </p>
      </main>
    );
  }

  return (
    <>
      {screen}
      {fullscreen.outside && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-label={STRINGS.returnToFullscreen}
          data-testid="fullscreen-overlay"
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-zinc-950 p-8 text-center text-white"
        >
          <p className="text-2xl">{STRINGS.fullscreenExited}</p>
          <button
            type="button"
            autoFocus
            onClick={() => void fullscreen.enter()}
            className="min-h-20 rounded-full bg-blue-600 px-12 text-2xl font-semibold"
          >
            {STRINGS.returnToFullscreen}
          </button>
        </div>
      )}
    </>
  );
}
