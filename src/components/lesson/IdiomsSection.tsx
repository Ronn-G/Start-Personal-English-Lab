"use client";

import SpeakButton from "@/components/lesson/SpeakButton";
import type { IdiomItem } from "@/types/lesson";

interface IdiomsSectionProps {
  items: IdiomItem[];
}

export default function IdiomsSection({ items }: IdiomsSectionProps) {
  if (items.length === 0) {
    return (
      <div className="rounded-2xl border-2 border-dashed border-border bg-highlight p-6 py-16 text-center">
        <p className="text-4xl">💬</p>
        <p className="mt-4 text-lg font-bold text-heading">
          Không có thành ngữ hoặc tiếng lóng trong bài này
        </p>
        <p className="mt-2 text-sm text-body">
          Hãy thử video khác có nhiều cách nói tự nhiên hơn.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {items.map((item) => (
        <article
          key={item.phrase}
          className="rounded-2xl border-2 border-border bg-card p-6 shadow-sm"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p className="text-xl font-bold text-heading">{item.phrase}</p>
            <SpeakButton text={item.phrase} label="Nghe" rate={0.82} />
          </div>
          <p className="mt-3 text-base leading-7 text-body">{item.meaning}</p>
          <p className="mt-2 text-sm font-bold text-translation">
            {item.vietnamese}
          </p>
          {item.note ? (
            <p className="mt-4 rounded-xl bg-highlight p-6 text-sm leading-6 text-body">
              💡 {item.note}
            </p>
          ) : null}
        </article>
      ))}
    </div>
  );
}
