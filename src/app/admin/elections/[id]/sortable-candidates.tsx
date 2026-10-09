"use client";

import { useState, useTransition } from "react";

interface Item {
  id: string;
  label: string;
}

/**
 * Candidate list that can be re-ordered by dragging. The browser only sends the new order to a
 * server action; the server validates it and stores it. Without JavaScript the "Move" buttons
 * in the page (plain forms) do the same job.
 */
export function SortableCandidates({
  electionId,
  postId,
  items,
  reorderAction,
}: {
  electionId: string;
  postId: string;
  items: Item[];
  reorderAction: (formData: FormData) => Promise<void>;
}) {
  const [order, setOrder] = useState(items);
  const [dragging, setDragging] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function drop(targetId: string) {
    if (!dragging || dragging === targetId) return;
    const from = order.findIndex((i) => i.id === dragging);
    const to = order.findIndex((i) => i.id === targetId);
    const next = [...order];
    next.splice(to, 0, ...next.splice(from, 1)); // the dragged item takes the target's slot
    setOrder(next);
    setDragging(null);
    const formData = new FormData();
    formData.set("electionId", electionId);
    formData.set("postId", postId);
    for (const item of next) formData.append("orderedIds", item.id);
    startTransition(() => reorderAction(formData));
  }

  return (
    <ol className="flex flex-col gap-1" data-testid="sortable-list" aria-busy={pending}>
      {order.map((item, index) => (
        <li
          key={item.id}
          draggable
          data-testid="sortable-item"
          onDragStart={() => setDragging(item.id)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => drop(item.id)}
          className="flex cursor-grab items-center gap-2 rounded-md border border-zinc-200 px-3 py-1 text-sm dark:border-zinc-800"
        >
          <span aria-hidden className="text-zinc-400">
            ⋮⋮
          </span>
          <span className="w-6 text-zinc-500">{index + 1}.</span>
          <span>{item.label}</span>
        </li>
      ))}
    </ol>
  );
}
