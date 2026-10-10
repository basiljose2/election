"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionResult } from "./actions";

export const IDLE_LOCK_MS = 5 * 60 * 1000;
const STORAGE_KEY = "master-terminal-locked";

function remember(locked: boolean) {
  try {
    if (locked) sessionStorage.setItem(STORAGE_KEY, "1");
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be blocked; the lock still works for this page load.
  }
}

function wasLocked(): boolean {
  try {
    return typeof sessionStorage !== "undefined" && sessionStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Locks the screen after 5 minutes without interaction. The lock survives a reload of the tab.
 * It is a convenience over the real protection: critical actions need a fresh password on the
 * server whatever this overlay does.
 */
export function useIdleLock() {
  const [locked, setLocked] = useState(wasLocked);
  const lockedRef = useRef(locked);
  const lastActivity = useRef(0);

  const lock = useCallback(() => {
    lockedRef.current = true;
    remember(true);
    setLocked(true);
  }, []);

  useEffect(() => {
    lastActivity.current = Date.now();
    const touch = () => {
      if (!lockedRef.current) lastActivity.current = Date.now();
    };
    const events = ["pointerdown", "keydown", "touchstart"] as const;
    for (const name of events) window.addEventListener(name, touch, { capture: true });
    const timer = setInterval(() => {
      if (!lockedRef.current && Date.now() - lastActivity.current >= IDLE_LOCK_MS) lock();
    }, 1000);
    return () => {
      for (const name of events) window.removeEventListener(name, touch, { capture: true });
      clearInterval(timer);
    };
  }, [lock]);

  const unlock = useCallback(() => {
    lastActivity.current = Date.now();
    lockedRef.current = false;
    remember(false);
    setLocked(false);
  }, []);

  return { locked, unlock };
}

/** Stays below the status and counts, which remain visible; only actions are blocked. */
export function LockOverlay({
  reauth,
  onUnlock,
}: {
  reauth: (password: string) => Promise<ActionResult>;
  onUnlock: () => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function unlock(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await reauth(password);
      if (result.ok) {
        setPassword("");
        onUnlock();
      } else {
        setError(result.error);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-label="Screen locked"
      data-testid="lock-overlay"
      className="fixed inset-x-0 bottom-0 z-50 border-t-4 border-amber-500 bg-zinc-950 p-4 text-zinc-100 shadow-2xl"
    >
      <form onSubmit={unlock} className="mx-auto flex max-w-3xl flex-wrap items-end gap-3">
        <p className="w-full text-lg font-semibold">Screen locked</p>
        <label className="flex min-w-60 flex-1 flex-col gap-1 text-sm font-medium">
          Presiding Officer password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-12 rounded-md border border-zinc-500 bg-zinc-900 px-3 text-base"
          />
        </label>
        <button
          type="submit"
          disabled={!password || busy}
          className="h-12 rounded-md bg-zinc-100 px-5 text-base font-medium text-zinc-900 disabled:bg-zinc-600 disabled:text-zinc-400"
        >
          Unlock
        </button>
        {error && (
          <p role="alert" className="w-full text-sm text-red-300">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
