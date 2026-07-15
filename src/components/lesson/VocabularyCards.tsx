"use client";

import { useCallback, useRef, useState } from "react";

import SpeakButton from "@/components/lesson/SpeakButton";
import type { VocabularyItem } from "@/types/lesson";

const STAGGER_MS = 150;

interface VocabularyCardsProps {
  items: VocabularyItem[];
  onReview?: (word: string) => void;
}

export default function VocabularyCards({
  items,
  onReview,
}: VocabularyCardsProps) {
  const [flippedWord, setFlippedWord] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCardClick = useCallback(
    (word: string) => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }

      if (flippedWord === word) {
        setFlippedWord(null);
        return;
      }

      onReview?.(word);

      if (flippedWord !== null) {
        setFlippedWord(null);
        timeoutRef.current = setTimeout(() => {
          setFlippedWord(word);
          timeoutRef.current = null;
        }, STAGGER_MS);
        return;
      }

      setFlippedWord(word);
    },
    [flippedWord, onReview],
  );

  return (
    <div className="grid gap-6 sm:grid-cols-2">
      {items.map((item) => {
        const isFlipped = flippedWord === item.word;

        return (
          <div
            key={item.word}
            role="button"
            tabIndex={0}
            onClick={() => handleCardClick(item.word)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                handleCardClick(item.word);
              }
            }}
            className="flip-scene w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            aria-pressed={isFlipped}
          >
            <div className={`flip-inner ${isFlipped ? "is-flipped" : ""}`}>
              <div className="flip-face flex flex-col items-center justify-center rounded-2xl border-2 border-border bg-card p-6 shadow-sm">
                <span className="shrink-0 text-xs font-bold uppercase tracking-wider text-primary">
                  Chạm để xem
                </span>
                <p className="mt-2 line-clamp-3 w-full break-words text-center text-xl font-bold leading-snug text-heading sm:text-2xl">
                  {item.word}
                </p>
                {item.phonetic ? (
                  <p className="mt-1 text-sm font-bold text-muted">
                    {item.phonetic}
                  </p>
                ) : null}
                <div className="mt-4">
                  <SpeakButton text={item.word} />
                </div>
              </div>

              <div className="flip-face flip-back flex flex-col rounded-2xl border-2 border-border bg-highlight p-6 shadow-sm">
                <div className="scrollbar-hidden flex min-h-0 flex-1 flex-col overflow-y-auto">
                  <div className="flex shrink-0 items-start justify-between gap-3">
                    <div>
                      <p className="break-words text-base font-bold leading-snug text-heading">
                        {item.word}
                      </p>
                      {item.phonetic ? (
                        <p className="mt-1 text-sm font-bold text-muted">
                          {item.phonetic}
                        </p>
                      ) : null}
                    </div>
                    <SpeakButton text={item.word} />
                  </div>
                  <p className="mt-2 shrink-0 break-words text-sm leading-5 text-body">
                    {item.definition}
                  </p>
                  <p className="mt-2 shrink-0 break-words text-sm font-bold leading-5 text-translation">
                    {item.vietnamese}
                  </p>
                  {item.context ? (
                    <div className="mt-3 shrink-0 rounded-xl bg-card p-3">
                      <p className="break-words text-xs italic leading-5 text-heading">
                        “{item.context}”
                      </p>
                      <div className="mt-2">
                        <SpeakButton text={item.context} label="Nghe câu" rate={0.82} />
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
