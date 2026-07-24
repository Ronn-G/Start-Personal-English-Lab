import ActivePracticeSection from "@/components/lesson/ActivePracticeSection";
import SpeakButton from "@/components/lesson/SpeakButton";
import type { DeepPractice, ExampleSentence } from "@/types/lesson";
import type { PracticeHistoryItem } from "@/lib/lesson-progress";

interface DeepPracticeSectionProps {
  practice?: DeepPractice;
  lessonTitle: string;
  exampleSentences: ExampleSentence[];
  practiceHistory: PracticeHistoryItem[];
  onPracticeComplete: (record: PracticeHistoryItem) => void;
}

export default function DeepPracticeSection({
  practice,
  lessonTitle,
  exampleSentences,
  practiceHistory,
  onPracticeComplete,
}: DeepPracticeSectionProps) {
  if (!practice) {
    return (
      <div className="rounded-2xl border-2 border-dashed border-border bg-highlight p-6 py-14 text-center">
        <p className="text-lg font-bold text-heading">Bài học này chưa có phần luyện sâu.</p>
        <p className="mt-2 text-sm text-body">
          Hãy tạo lại bằng prompt mới để có shadowing, sentence mining và Anki cards.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border-2 border-border bg-card p-6 shadow-sm">
        <h3 className="text-xl font-extrabold text-heading">Shadowing practice</h3>
        <ol className="mt-4 grid gap-3 text-sm leading-6 text-body sm:grid-cols-3">
          {practice.shadowingPractice.steps.map((step, index) => (
            <li key={`${step}-${index}`} className="rounded-xl bg-highlight p-4">
              <span className="font-extrabold text-primary">Bước {index + 1}: </span>
              {step}
            </li>
          ))}
        </ol>
        <div className="mt-5 space-y-3">
          {practice.shadowingPractice.lines.map((line, index) => (
            <article
              key={`${line.line}-${index}`}
              className="rounded-xl border-2 border-border p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <p className="text-base font-bold leading-7 text-heading">{line.line}</p>
                <SpeakButton text={line.line} label="Nghe" rate={0.78} />
              </div>
              <p className="mt-2 text-sm leading-6 text-body">
                <span className="font-bold text-primary">Focus: </span>
                {line.focus}
              </p>
              <p className="mt-1 text-sm font-bold leading-6 text-translation">{line.vietnamese}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border-2 border-border bg-card p-6 shadow-sm">
        <h3 className="text-xl font-extrabold text-heading">Sentence mining</h3>
        <div className="mt-4 grid gap-4">
          {practice.sentenceMining.map((item, index) => (
            <article key={`${item.sentence}-${index}`} className="rounded-xl bg-highlight p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <p className="text-base font-bold leading-7 text-heading">{item.sentence}</p>
                <SpeakButton text={item.sentence} label="Nghe câu" rate={0.82} />
              </div>
              <p className="mt-3 text-sm leading-6 text-body">
                <span className="font-bold text-primary">Pattern: </span>
                {item.pattern}
              </p>
              <p className="mt-1 text-sm leading-6 text-body">
                <span className="font-bold text-primary">Vì sao đáng học: </span>
                {item.whyUseful}
              </p>
              <p className="mt-3 rounded-xl bg-card p-3 text-sm font-bold leading-6 text-heading">
                {item.remixPrompt}
              </p>
            </article>
          ))}
        </div>
      </section>

      <ActivePracticeSection
        lessonTitle={lessonTitle}
        prompts={exampleSentences}
        history={practiceHistory}
        onComplete={onPracticeComplete}
      />

      <section className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="rounded-2xl border-2 border-border bg-card p-6 shadow-sm">
          <h3 className="text-xl font-extrabold text-heading">Review plan</h3>
          <div className="mt-4 space-y-3">
            {practice.reviewPlan.map((item) => (
              <article key={item.day} className="rounded-xl bg-highlight p-4">
                <p className="text-sm font-extrabold uppercase tracking-wide text-primary">
                  {item.day}
                </p>
                <p className="mt-2 text-sm leading-6 text-body">{item.task}</p>
              </article>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border-2 border-border bg-card p-6 shadow-sm">
          <h3 className="text-xl font-extrabold text-heading">Anki cards</h3>
          <div className="mt-4 space-y-3">
            {practice.ankiCards.map((card, index) => (
              <article
                key={`${card.front}-${index}`}
                className="rounded-xl border-2 border-border p-4"
              >
                <p className="text-sm font-bold leading-6 text-heading">Front: {card.front}</p>
                <p className="mt-2 text-sm leading-6 text-body">Back: {card.back}</p>
                {card.hint ? (
                  <p className="mt-2 text-xs font-bold uppercase tracking-wide text-primary">
                    Hint: {card.hint}
                  </p>
                ) : null}
              </article>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
