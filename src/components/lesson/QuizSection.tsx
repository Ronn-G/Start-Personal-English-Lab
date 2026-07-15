"use client";

import { useState } from "react";

import type { QuizQuestion } from "@/types/lesson";

interface QuizSectionProps {
  questions: QuizQuestion[];
  onAnswer?: (index: number) => void;
}

function CelebrationOverlay() {
  const particles = ["🎉", "✨", "⭐", "🎊", "🧡"];

  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
      {particles.map((emoji, index) => (
        <span
          key={emoji}
          className="confetti-particle absolute text-2xl"
          style={{
            left: `${20 + index * 15}%`,
            animationDelay: `${index * 0.08}s`,
          }}
        >
          {emoji}
        </span>
      ))}
    </div>
  );
}

export default function QuizSection({ questions, onAnswer }: QuizSectionProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [score, setScore] = useState(0);
  const [isFinished, setIsFinished] = useState(false);
  const [showCelebration, setShowCelebration] = useState(false);

  const currentQuestion = questions[currentIndex];
  const hasAnswered = selectedOption !== null;
  const isCorrect =
    hasAnswered && selectedOption === currentQuestion?.correctAnswer;

  function resetQuiz() {
    setCurrentIndex(0);
    setSelectedOption(null);
    setScore(0);
    setIsFinished(false);
    setShowCelebration(false);
  }

  function handleSelect(optionIndex: number) {
    if (hasAnswered || isFinished) {
      return;
    }

    setSelectedOption(optionIndex);
    onAnswer?.(currentIndex);

    if (optionIndex === currentQuestion.correctAnswer) {
      setScore((value) => value + 1);
      setShowCelebration(true);
    }
  }

  function handleNext() {
    setShowCelebration(false);

    if (currentIndex >= questions.length - 1) {
      setIsFinished(true);
      return;
    }

    setCurrentIndex((value) => value + 1);
    setSelectedOption(null);
  }

  if (isFinished) {
    const total = questions.length;
    const perfect = score === total;

    return (
      <div className="flex flex-col items-center rounded-2xl border-2 border-border bg-card p-6 py-14 text-center shadow-sm">
        <p className="text-5xl">{perfect ? "🏆" : "🎉"}</p>
        <h3 className="mt-6 text-3xl font-extrabold text-heading">
          Bạn trả lời đúng {score}/{total}!
        </h3>
        <p className="mt-3 text-base text-body">
          {perfect
            ? "Xuất sắc — bạn làm rất tốt!"
            : score >= total / 2
              ? "Làm tốt lắm — tiếp tục cố gắng nhé!"
              : "Hãy ôn lại từ vựng và thử lại nhé!"}
        </p>
        <button
          type="button"
          onClick={resetQuiz}
          className="button-depth mt-8 rounded-2xl bg-accent px-8 py-4 text-base font-extrabold uppercase tracking-wide text-accent-foreground transition ease-smooth hover:bg-accent-hover active:translate-y-0.5"
        >
          Làm lại
        </button>
      </div>
    );
  }

  const progress =
    ((currentIndex + (hasAnswered ? 1 : 0)) / questions.length) * 100;

  return (
    <div className="relative space-y-8">
      <div className="space-y-3">
        <div className="flex items-center justify-between text-sm font-bold text-body">
          <span>
            Câu {currentIndex + 1} / {questions.length}
          </span>
          <span>
            {currentIndex + 1}/{questions.length}
          </span>
        </div>
        <div className="h-4 overflow-hidden rounded-full bg-border">
          <div
            className="h-full rounded-full bg-gradient-accent transition-all duration-500 ease-smooth"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      <div
        className={`relative rounded-2xl border-2 border-border bg-card p-6 shadow-sm ${
          showCelebration ? "animate-celebrate" : ""
        }`}
      >
        {showCelebration ? <CelebrationOverlay /> : null}

        <p className="text-xl font-extrabold leading-8 text-heading">
          {currentQuestion.question}
        </p>

        <ul className="mt-8 space-y-3">
          {currentQuestion.options.map((option, optionIndex) => {
            const isSelected = selectedOption === optionIndex;
            const isCorrectOption =
              optionIndex === currentQuestion.correctAnswer;

            let optionClass =
              "border-border bg-card text-heading hover:bg-highlight";

            if (hasAnswered) {
              if (isCorrectOption) {
                optionClass =
                  "border-correct bg-correct-light text-heading";
              } else if (isSelected) {
                optionClass = "border-wrong bg-wrong-light text-heading";
              } else {
                optionClass = "border-border bg-card text-muted opacity-60";
              }
            }

            return (
              <li key={`${option}-${optionIndex}`}>
                <button
                  type="button"
                  disabled={hasAnswered}
                  onClick={() => handleSelect(optionIndex)}
                  className={`w-full rounded-2xl border-2 px-5 py-4 text-left text-base font-bold transition ease-smooth disabled:cursor-default ${optionClass}`}
                >
                  <span className="mr-3 inline-flex h-8 w-8 items-center justify-center rounded-lg bg-background text-sm font-extrabold text-body">
                    {String.fromCharCode(65 + optionIndex)}
                  </span>
                  {option}
                  {hasAnswered && isCorrectOption ? (
                    <span className="ml-2">✓</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>

        {hasAnswered ? (
          <div className="mt-6 space-y-4">
            <p
              className={`rounded-2xl px-4 py-3 text-sm font-semibold ${
                isCorrect
                  ? "bg-correct-light text-heading"
                  : "bg-wrong-light text-wrong"
              }`}
            >
              {isCorrect
                ? "Chính xác! 🎉"
                : "Chưa đúng — xem đáp án đúng ở trên nhé."}
            </p>
            <p className="text-sm leading-6 text-body">
              {currentQuestion.explanation}
            </p>
            <button
              type="button"
              onClick={handleNext}
              className="button-depth w-full rounded-2xl bg-accent px-6 py-4 text-base font-extrabold uppercase tracking-wide text-accent-foreground transition ease-smooth hover:bg-accent-hover active:translate-y-0.5"
            >
              {currentIndex >= questions.length - 1 ? "Xem kết quả" : "Tiếp tục"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
