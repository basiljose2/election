"use client";

import { useEffect, useRef, useState } from "react";
import type { Signal, SignalSubscriber, Subscription } from "./types";

export const POLL_INTERVAL_MS = 2_000;
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** Ask for a new channel token this long before the current one expires. */
const TOKEN_REFRESH_MARGIN_MS = 3 * 60 * 1000;
const TOKEN_RETRY_MS = 10_000;

export type ConnectionMode = "connecting" | "realtime" | "polling";

interface ChannelAccess {
  provider: "supabase" | "ably";
  expiresAt: string;
  token?: string;
  tokenRequest?: Record<string, unknown>;
  realtimeUrl?: string;
  apiKey?: string;
}

async function subscriberFor(
  access: ChannelAccess,
): Promise<{ subscriber: SignalSubscriber; token: string }> {
  if (access.provider === "ably") {
    const { ablySubscriber } = await import("./ably-client");
    return { subscriber: ablySubscriber(), token: JSON.stringify(access.tokenRequest) };
  }
  const { supabaseSubscriber } = await import("./supabase-client");
  return {
    subscriber: supabaseSubscriber({ realtimeUrl: access.realtimeUrl!, apiKey: access.apiKey! }),
    token: access.token!,
  };
}

/**
 * Keeps a terminal's view in step with the server.
 *
 * Signals are only hints: the hook re-fetches the authoritative state on load, on every
 * signal that is newer than the state it holds, and on every (re)connect. Stale signals are
 * ignored. When the real-time connection is down it polls every 2 seconds until it returns.
 * It also sends a heartbeat every 10 seconds. A 401/403 means the credential was revoked.
 */
export function useTerminalState<S extends { version: number }>(options: {
  /** "/master/api" or "/terminal/api" */
  base: string;
}) {
  const { base } = options;
  const [state, setState] = useState<S | null>(null);
  const [mode, setMode] = useState<ConnectionMode>("connecting");
  const [unpaired, setUnpaired] = useState(false);
  const versionRef = useRef(-1);

  useEffect(() => {
    let stopped = false;
    let subscription: Subscription | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    async function refresh() {
      try {
        const response = await fetch(`${base}/state`, { cache: "no-store" });
        if (response.status === 401 || response.status === 403) {
          stopped = true;
          setUnpaired(true);
          return;
        }
        if (!response.ok) return;
        const next = (await response.json()) as S;
        // Ignore responses that arrive out of order.
        if (!stopped && next.version >= versionRef.current) {
          versionRef.current = next.version;
          setState(next);
        }
      } catch {
        // Offline: the next poll or reconnect tries again.
      }
    }

    function startPolling() {
      if (pollTimer) return;
      setMode("polling");
      pollTimer = setInterval(refresh, POLL_INTERVAL_MS);
    }
    function stopPolling() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = undefined;
    }

    function onSignal(signal: Signal) {
      // A signal no newer than the state we already hold carries no news.
      if (signal.version > versionRef.current) void refresh();
    }

    async function connect() {
      subscription?.unsubscribe();
      subscription = undefined;
      try {
        const response = await fetch(`${base}/channel-token`, { cache: "no-store" });
        if (response.status === 401 || response.status === 403) {
          stopped = true;
          setUnpaired(true);
          return;
        }
        if (!response.ok) throw new Error("token");
        const access = (await response.json()) as ChannelAccess & { topic: string };
        const { subscriber, token } = await subscriberFor(access);
        if (stopped) return;
        const boothId = access.topic.replace(/^booth:/, "");
        subscription = subscriber.subscribe(
          { boothId, token },
          {
            onSignal,
            onStatus(status) {
              if (stopped) return;
              if (status === "connected") {
                stopPolling();
                setMode("realtime");
                void refresh(); // anything missed while disconnected
              } else {
                startPolling();
              }
            },
          },
        );
        const wait = Math.max(
          TOKEN_RETRY_MS,
          new Date(access.expiresAt).getTime() - Date.now() - TOKEN_REFRESH_MARGIN_MS,
        );
        refreshTimer = setTimeout(connect, wait);
      } catch {
        // Real-time unavailable: poll, and try to connect again shortly.
        startPolling();
        refreshTimer = setTimeout(connect, TOKEN_RETRY_MS);
      }
    }

    async function heartbeat() {
      try {
        await fetch(`${base}/heartbeat`, { method: "POST", cache: "no-store" });
      } catch {
        // A missed heartbeat is visible to the Master Terminal as offline; nothing else to do.
      }
    }

    void refresh();
    void connect();
    void heartbeat();
    const heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
    const onOnline = () => void refresh();
    window.addEventListener("online", onOnline);

    return () => {
      stopped = true;
      subscription?.unsubscribe();
      stopPolling();
      if (refreshTimer) clearTimeout(refreshTimer);
      clearInterval(heartbeatTimer);
      window.removeEventListener("online", onOnline);
    };
  }, [base]);

  return { state, mode, unpaired };
}
