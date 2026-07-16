"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import DeepPracticeSection from "@/components/lesson/DeepPracticeSection";
import GrammarSection from "@/components/lesson/GrammarSection";
import IdiomsSection from "@/components/lesson/IdiomsSection";
import QuizSection from "@/components/lesson/QuizSection";
import VocabularyCards from "@/components/lesson/VocabularyCards";
import { CURRENT_PROGRESS_SCHEMA_VERSION, type LessonProgress } from "@/lib/lesson-progress";
import { storageClient } from "@/lib/storage-client";
import type { Lesson } from "@/types/lesson";

type LessonTab = "vocabulary" | "idioms" | "grammar" | "practice" | "quiz";

const TABS: { id: LessonTab; label: string; emoji: string }[] = [
  { id: "vocabulary", label: "Từ vựng", emoji: "📚" },
  { id: "idioms", label: "Thành ngữ", emoji: "💬" },
  { id: "grammar", label: "Ngữ pháp", emoji: "✏️" },
  { id: "practice", label: "Luyện sâu", emoji: "🎧" },
  { id: "quiz", label: "Kiểm tra", emoji: "🎯" },
];

interface LessonDisplayProps {
  lesson: Lesson;
  lessonId?: string;
  videoId?: string;
}

function emptyProgress(lessonId: string, timestamp: string): LessonProgress {
  return { lessonId, progressVersion: CURRENT_PROGRESS_SCHEMA_VERSION, quizItems: {}, learningItems: {}, visitedSections: ["vocabulary"], practiceHistory: [], createdAt: timestamp, updatedAt: timestamp };
}

export default function LessonDisplay({ lesson, lessonId, videoId }: LessonDisplayProps) {
  const storageLessonId = lessonId ?? lesson.id;
  const [activeTab, setActiveTab] = useState<LessonTab>("vocabulary");
  const [reviewedWords, setReviewedWords] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<LessonProgress>(() => emptyProgress(storageLessonId, lesson.createdAt));
  const [progressLoading, setProgressLoading] = useState(true);
  const [progressError, setProgressError] = useState<string | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const [visitedTabs, setVisitedTabs] = useState<Set<LessonTab>>(
    new Set<LessonTab>(["vocabulary"]),
  );

  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const [canExpandSummary, setCanExpandSummary] = useState(false);
  const summaryRef = useRef<HTMLParagraphElement>(null);

  const navRef = useRef<HTMLElement>(null);
  const [showLeftFade, setShowLeftFade] = useState(false);
  const [showRightFade, setShowRightFade] = useState(false);

  const updateFades = useCallback(() => {
    const el = navRef.current;
    if (!el) {
      return;
    }
    const { scrollLeft, scrollWidth, clientWidth } = el;
    setShowLeftFade(scrollLeft > 4);
    setShowRightFade(scrollLeft + clientWidth < scrollWidth - 4);
  }, []);

  useEffect(() => {
    updateFades();
    window.addEventListener("resize", updateFades);
    return () => window.removeEventListener("resize", updateFades);
  }, [updateFades]);

  useEffect(() => {
    const el = summaryRef.current;
    if (el && !summaryExpanded) {
      setCanExpandSummary(el.scrollHeight > el.clientHeight + 1);
    }
  }, [lesson.summary, summaryExpanded]);

  useEffect(() => {
    let active = true;
    storageClient.getLessonProgress(storageLessonId).then((stored) => {
      if (active) setProgress(stored?.progress ?? emptyProgress(storageLessonId, lesson.createdAt));
    }).catch((reason) => { if (active) setProgressError(reason instanceof Error ? reason.message : "Không thể tải tiến độ."); }).finally(() => { if (active) setProgressLoading(false); });
    return () => { active = false; };
  }, [lesson.createdAt, storageLessonId]);

  const handleReviewWord = useCallback((word: string) => {
    setReviewedWords((prev) => {
      if (prev.has(word)) {
        return prev;
      }

      const next = new Set(prev);
      next.add(word);
      return next;
    });
  }, [setReviewedWords]);

  const handleAnswerQuestion = useCallback((question: Lesson["quiz"][number], selectedAnswer: number) => {
    setProgress((previous) => {
      const now = new Date().toISOString();
      const old = previous.quizItems[question.id];
      const next: LessonProgress = { ...previous, updatedAt: now, quizItems: { ...previous.quizItems, [question.id]: { itemId: question.id, selectedAnswer, correct: selectedAnswer === question.correctAnswer, attemptCount: (old?.attemptCount ?? 0) + 1, answeredAt: now, completed: true } } };
      setProgressError(null);
      saveQueue.current = saveQueue.current.catch(() => undefined).then(async () => {
        try { await storageClient.saveLessonProgress(storageLessonId, next); }
        catch (reason) { setProgressError(reason instanceof Error ? `Chưa lưu tiến độ: ${reason.message}` : "Chưa lưu tiến độ."); }
      });
      return next;
    });
  }, [storageLessonId]);

  function selectTab(id: LessonTab) {
    setActiveTab(id);
    setVisitedTabs((prev) => {
      if (prev.has(id)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }

  function tabProgress(id: LessonTab): { done: number; total: number } {
    switch (id) {
      case "vocabulary":
        return { done: reviewedWords.size, total: lesson.vocabulary.length };
      case "quiz":
        return { done: Object.keys(progress.quizItems).length, total: lesson.quiz.length };
      case "idioms":
        return {
          done: visitedTabs.has("idioms") ? lesson.idiomsAndSlang.length : 0,
          total: lesson.idiomsAndSlang.length,
        };
      case "grammar":
        return {
          done: visitedTabs.has("grammar") ? lesson.exampleSentences.length : 0,
          total: lesson.exampleSentences.length,
        };
      case "practice": {
        const total =
          (lesson.deepPractice?.shadowingPractice.lines.length ?? 0) +
          (lesson.deepPractice?.sentenceMining.length ?? 0) +
          (lesson.deepPractice?.reviewPlan.length ?? 0) +
          (lesson.deepPractice?.ankiCards.length ?? 0);

        return {
          done: visitedTabs.has("practice") ? total : 0,
          total,
        };
      }
    }
  }

  const thumbnailUrl = videoId
    ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
    : null;
  const videoUrl = videoId
    ? `https://www.youtube.com/watch?v=${videoId}`
    : null;

  return (
    <div>
      <header className="mb-8">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
          {videoUrl && thumbnailUrl ? (
            <a
              href={videoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="group relative block w-full shrink-0 overflow-hidden rounded-2xl border-2 border-border sm:w-52"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={thumbnailUrl}
                alt={`Ảnh thu nhỏ của video: ${lesson.title}`}
                className="aspect-video w-full object-cover transition ease-smooth group-hover:scale-105"
                loading="lazy"
              />
              <span className="absolute inset-0 flex items-center justify-center bg-black/15 opacity-0 transition ease-smooth group-hover:opacity-100">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/90 shadow-sm">
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path d="M8 5v14l11-7L8 5z" fill="currentColor" />
                  </svg>
                </span>
              </span>
            </a>
          ) : null}

          <div className="flex-1 space-y-3 text-center sm:text-left">
            <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-muted">
              Bài học của bạn đã sẵn sàng!
            </p>
            <h2 className="text-3xl font-extrabold leading-tight text-heading">
              {lesson.title}
            </h2>

            <div>
              <p
                ref={summaryRef}
                className={`max-w-2xl text-base leading-7 text-body ${
                  summaryExpanded ? "" : "line-clamp-2"
                }`}
              >
                {lesson.summary}
              </p>
              {canExpandSummary || summaryExpanded ? (
                <button
                  type="button"
                  onClick={() => setSummaryExpanded((value) => !value)}
                  className="mt-1 text-sm font-bold text-primary transition ease-smooth hover:text-primary-hover"
                >
                  {summaryExpanded ? "Thu gọn" : "Xem thêm"}
                </button>
              ) : null}
            </div>

            {videoUrl ? (
              <a
                href={videoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-full border-2 border-border bg-card px-4 py-2 text-sm font-bold text-primary shadow-sm transition ease-smooth hover:border-primary hover:bg-highlight"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                >
                  <path d="M8 5v14l11-7L8 5z" fill="currentColor" />
                </svg>
                Xem video gốc
              </a>
            ) : null}
          </div>
        </div>
      </header>

      <div className="relative -mx-6 mb-4 sm:-mx-8">
        <nav
          ref={navRef}
          onScroll={updateFades}
          aria-label="Các phần bài học"
          className="flex gap-2.5 overflow-x-auto px-6 pb-7 pt-3 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:px-8"
        >
          {TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          const { done, total } = tabProgress(tab.id);
          const isComplete = total > 0 && done >= total;

          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => selectTab(tab.id)}
              className={`flex shrink-0 items-center rounded-full border-2 px-3 py-2.5 text-xs font-extrabold transition ease-smooth sm:px-3.5 sm:py-3 sm:text-sm ${
                isActive
                  ? "theme-active-shadow scale-[1.03] border-primary bg-primary text-white"
                  : "border-border bg-tab-inactive text-body hover:border-primary hover:text-primary"
              }`}
            >
              <span className="mr-2">{tab.emoji}</span>
              {tab.label}
              {total > 0 ? (
                <span
                  className={`ml-2 inline-flex min-w-[2rem] items-center justify-center rounded-full px-2 py-0.5 text-xs font-bold ${
                    isActive
                      ? "bg-white/25 text-white"
                      : isComplete
                        ? "bg-correct text-white"
                        : "bg-card text-primary"
                  }`}
                >
                  {isComplete ? "✓" : `${done}/${total}`}
                </span>
              ) : null}
            </button>
          );
          })}
        </nav>

        {showLeftFade ? (
          <div className="pointer-events-none absolute bottom-0 left-0 top-0 flex items-center bg-gradient-to-r from-card via-card/80 to-transparent pl-2 pr-6 text-primary">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M15 18l-6-6 6-6"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        ) : null}

        {showRightFade ? (
          <div className="pointer-events-none absolute bottom-0 right-0 top-0 flex items-center justify-end bg-gradient-to-l from-card via-card/80 to-transparent pl-6 pr-2 text-primary">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
              className="animate-pulse"
            >
              <path
                d="M9 6l6 6-6 6"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        ) : null}
      </div>

      <div className="min-h-[320px]">
        {progressLoading ? <p className="mb-4 text-sm font-bold text-muted">Đang tải tiến độ quiz...</p> : null}
        {progressError ? <div role="alert" className="mb-4 rounded-xl border-2 border-wrong bg-wrong-light p-3 text-sm font-bold text-wrong">{progressError} Tiến độ trên màn hình vẫn được giữ. <button type="button" className="underline" onClick={() => { setProgressError(null); void storageClient.saveLessonProgress(storageLessonId, progress).catch((reason) => setProgressError(reason instanceof Error ? reason.message : "Vẫn chưa lưu được.")); }}>Thử lại</button></div> : null}
        {activeTab === "vocabulary" ? (
          <VocabularyCards
            items={lesson.vocabulary}
            onReview={handleReviewWord}
          />
        ) : null}

        {activeTab === "idioms" ? (
          <IdiomsSection items={lesson.idiomsAndSlang} />
        ) : null}

        {activeTab === "grammar" ? (
          <GrammarSection items={lesson.exampleSentences} />
        ) : null}

        {activeTab === "practice" ? (
          <DeepPracticeSection
            practice={lesson.deepPractice}
            lessonTitle={lesson.title}
            exampleSentences={lesson.exampleSentences}
          />
        ) : null}

        {activeTab === "quiz" ? (
          <QuizSection
            key={`${storageLessonId}-${progressLoading ? "loading" : "ready"}`}
            questions={lesson.quiz}
            progress={progress.quizItems}
            onAnswer={handleAnswerQuestion}
          />
        ) : null}
      </div>
    </div>
  );
}
