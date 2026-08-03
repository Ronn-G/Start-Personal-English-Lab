"use client";

import SpeakButton from "@/components/lesson/SpeakButton";

export interface RelistenDashboardItem {
  lessonId: string;
  title: string;
  itemId: string;
  sourceType: string;
  sourceItemId: string;
  text: string;
  targetPhrase?: string;
}

export default function RelistenDashboard({
  items,
  removingId,
  onOpen,
  onRemove,
}: {
  items: RelistenDashboardItem[];
  removingId: string | null;
  onOpen: (lessonId: string) => void | Promise<void>;
  onRemove: (item: RelistenDashboardItem) => void | Promise<void>;
}) {
  if (!items.length) return null;
  return (
    <div className="mb-5 rounded-2xl bg-highlight p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-extrabold text-heading">Re-listen</h2>
          <p className="text-xs text-muted">Sentences you explicitly saved for later.</p>
        </div>
      </div>
      <div className="mt-3 grid gap-2">
        {items.slice(0, 5).map((item) => (
          <div key={item.itemId} className="rounded-xl bg-card p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-muted">{item.title}</p>
                <p className="font-bold text-heading">{item.text}</p>
                {item.targetPhrase ? (
                  <p className="text-xs text-muted">Target phrase: {item.targetPhrase}</p>
                ) : null}
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <SpeakButton
                text={item.text}
                label="Play"
                lessonId={`relisten:${item.lessonId}`}
                itemId={item.itemId}
                sourceType="relisten"
              />
              <button
                type="button"
                onClick={() => void onOpen(item.lessonId)}
                className="rounded-full border-2 border-primary px-3 py-2 text-xs font-extrabold text-primary"
              >
                Open lesson
              </button>
              <button
                type="button"
                disabled={removingId === item.itemId}
                onClick={() => void onRemove(item)}
                className="rounded-full border-2 border-border px-3 py-2 text-xs font-extrabold text-body disabled:cursor-wait disabled:opacity-50"
              >
                {removingId === item.itemId ? "Removing..." : "Remove from re-listen"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
