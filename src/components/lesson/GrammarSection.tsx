import SpeakButton from "@/components/lesson/SpeakButton";
import type { ExampleSentence } from "@/types/lesson";

interface GrammarSectionProps {
  items: ExampleSentence[];
}

function highlightPhrase(sentence: string, keyPhrase: string) {
  const parts = sentence.split(keyPhrase);

  return parts.map((part, index) => (
    <span key={`${part}-${index}`}>
      {part}
      {index < parts.length - 1 ? (
        <mark className="rounded-lg bg-highlight px-1.5 py-0.5 font-bold text-heading">
          {keyPhrase}
        </mark>
      ) : null}
    </span>
  ));
}

export default function GrammarSection({ items }: GrammarSectionProps) {
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-body">
        Học cách dùng các cụm từ quan trọng trong câu thực tế. Bấm nghe để luyện
        nhịp câu trước khi tự nói lại.
      </p>
      {items.map((item, index) => (
        <article
          key={`${item.sentence}-${index}`}
          className="rounded-2xl border-2 border-border bg-card p-6 shadow-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="inline-flex rounded-full bg-highlight px-3 py-1 text-xs font-bold uppercase tracking-wide text-primary">
              Câu {index + 1}
            </span>
            <SpeakButton text={item.sentence} label="Nghe câu" rate={0.82} />
          </div>
          <p className="mt-4 rounded-xl bg-highlight p-6 text-lg leading-8 text-heading">
            {highlightPhrase(item.sentence, item.keyPhrase)}
          </p>
          <p className="mt-3 text-sm font-bold leading-6 text-translation">
            {item.vietnamese}
          </p>
        </article>
      ))}
    </div>
  );
}
