"use client";

import { useEffect, useRef, useState } from "react";
import type { FeedEvent } from "@/lib/transparency/audit-feed";

/** The feed asks for events after the last one it has seen, every 5 seconds. */
export const FEED_REFRESH_MS = 5_000;

export function AuditFeed({ electionId, initial }: { electionId: string; initial: FeedEvent[] }) {
  const [events, setEvents] = useState(initial);
  const lastSeq = useRef(initial.at(-1)?.seq ?? 0);

  useEffect(() => {
    let stopped = false;
    async function poll() {
      try {
        const response = await fetch(
          `/api/elections/${electionId}/audit?after=${lastSeq.current}`,
          { cache: "no-store" },
        );
        if (!response.ok || stopped) return;
        const body = (await response.json()) as { events: FeedEvent[]; lastSeq: number };
        if (body.events.length > 0 && !stopped) {
          lastSeq.current = body.lastSeq;
          setEvents((current) => [...current, ...body.events]);
        }
      } catch {
        // Offline: the next tick tries again from the same sequence number.
      }
    }
    const timer = setInterval(poll, FEED_REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [electionId]);

  return (
    <ol className="flex flex-col gap-1 text-sm" data-testid="audit-feed" reversed>
      {[...events].reverse().map((e) => (
        <li
          key={e.seq}
          data-event={e.eventType}
          data-seq={e.seq}
          className="grid grid-cols-[3rem_9rem_1fr] gap-2 border-b border-zinc-200 py-1 dark:border-zinc-800"
        >
          <span className="tabular-nums text-zinc-600 dark:text-zinc-400">#{e.seq}</span>
          <time dateTime={e.occurredAt} className="text-zinc-600 dark:text-zinc-400">
            {new Date(e.occurredAt).toLocaleTimeString()}
          </time>
          <span>
            <span className="font-medium">{e.eventType}</span>
            {e.actorRole && (
              <span className="text-zinc-600 dark:text-zinc-400">
                {" "}
                · {e.actorRole.replace(/_/g, " ")}
              </span>
            )}
            {e.targetType && (
              <span className="text-zinc-600 dark:text-zinc-400">
                {" "}
                · {e.targetType} {e.targetId.slice(0, 8)}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}
