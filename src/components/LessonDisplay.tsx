"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import DeepPracticeSection from "@/components/lesson/DeepPracticeSection";
import GrammarSection from "@/components/lesson/GrammarSection";
import IdiomsSection from "@/components/lesson/IdiomsSection";
import QuizSection from "@/components/lesson/QuizSection";
import VocabularyCards from "@/components/lesson/VocabularyCards";
import {
  applyLessonProgressCommand,
  emptyLessonProgress,
  type LessonProgress,
  type LessonProgressCommand,
} from "@/lib/lesson-progress";
import { storageClient } from "@/lib/storage-client";
import type { Lesson } from "@/types/lesson";
import { audioClient } from "@/lib/audio-client";
import { selectLessonAudioPreloadItems } from "@/lib/audio-domain";
import AudioCacheControls from "@/components/AudioCacheControls";
import SpeakingPractice from "@/components/SpeakingPractice";
import ListeningPractice from "@/components/ListeningPractice";

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
  initialSpeakingOpen?: boolean;
  initialListeningOpen?: boolean;
}

export default function LessonDisplay({
  lesson,
  lessonId,
  videoId,
  initialSpeakingOpen = false,
  initialListeningOpen = false,
}: LessonDisplayProps) {
  const storageLessonId = lessonId ?? lesson.id;
  const [activeTab, setActiveTab] = useState<LessonTab>("vocabulary");
  const [speakingOpen, setSpeakingOpen] = useState(initialSpeakingOpen);
  const [listeningOpen, setListeningOpen] = useState(initialListeningOpen);
  const [returnToListening, setReturnToListening] = useState(false);
  const [listeningEntry, setListeningEntry] = useState<{
    label: string;
    detail: string;
  }>({
    label: "Start Listening Practice",
    detail: "Listen first, then review meaning and sentences",
  });
  const [speakingEntry, setSpeakingEntry] = useState<{ label: string; detail: string }>({
    label: "Start Speaking Practice",
    detail: "5–10 minutes · practice from this lesson",
  });
  const [progress, setProgress] = useState<LessonProgress>(() =>
    emptyLessonProgress(storageLessonId, lesson.createdAt),
  );
  const [progressLoading, setProgressLoading] = useState(true);
  const [progressError, setProgressError] = useState<string | null>(null);
  const [failedCommand, setFailedCommand] = useState<LessonProgressCommand | null>(null);
  const [audioProgress, setAudioProgress] = useState<{
    ready: number;
    total: number;
    failed: number;
  } | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
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
    storageClient
      .getLessonProgress(storageLessonId)
      .then((stored) => {
        if (active) {
          setProgress(stored?.progress ?? emptyLessonProgress(storageLessonId, lesson.createdAt));
        }
      })
      .catch((reason) => {
        if (active)
          setProgressError(reason instanceof Error ? reason.message : "Không thể tải tiến độ.");
      })
      .finally(() => {
        if (active) setProgressLoading(false);
      });
    return () => {
      active = false;
    };
  }, [lesson.createdAt, storageLessonId]);

  useEffect(() => {
    const items = selectLessonAudioPreloadItems(lesson);
    Promise.resolve().then(() => setAudioProgress({ ready: 0, total: items.length, failed: 0 }));
    if (document.visibilityState === "visible")
      audioClient.preload(items, (ready, total, failed) =>
        setAudioProgress({ ready, total, failed }),
      );
    return () => audioClient.cancelLesson(lesson.id);
  }, [lesson]);
  useEffect(() => {
    fetch("/api/speaking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "status", lessonId: storageLessonId }),
    })
      .then((r) => r.json())
      .then((data) => {
        const session = data.session,
          total = data.tasks?.length ?? 0;
        if (session?.status === "active")
          setSpeakingEntry({
            label: "Continue Speaking Practice",
            detail: `${session.currentItemIndex + 1} of ${total} · about 5–10 minutes`,
          });
        else if (session?.status === "completed")
          setSpeakingEntry({
            label: "Practice Again",
            detail: `${total} sentences · previous session complete`,
          });
        else
          setSpeakingEntry({
            label: "Start Speaking Practice",
            detail: `${total || "No"} sentences · about 5–10 minutes`,
          });
      })
      .catch(() => undefined);
  }, [storageLessonId, speakingOpen]);
  useEffect(() => {
    fetch("/api/listening", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "status", lessonId: storageLessonId }),
    })
      .then((response) => response.json())
      .then((data) => {
        const session = data.session;
        if (session?.status === "active") {
          setListeningEntry({
            label: "Continue Listening Practice",
            detail: `${String(session.currentStep)
              .replaceAll("_", " ")
              .replace(/\b\w/g, (letter) => letter.toUpperCase())} · progress saved`,
          });
        } else if (session?.status === "completed") {
          setListeningEntry({
            label: "Practice Again",
            detail: `${data.items?.length ?? 0} sentences · previous session complete`,
          });
        } else {
          setListeningEntry({
            label: "Start Listening Practice",
            detail: `${data.items?.length ?? 0} sentences · listen before reading`,
          });
        }
      })
      .catch(() => undefined);
  }, [listeningOpen, storageLessonId]);

  const persistCommand = useCallback(
    (command: LessonProgressCommand, optimistic = true) => {
      if (optimistic) {
        setProgress((previous) => applyLessonProgressCommand(previous, lesson, command));
      }
      setProgressError(null);
      setFailedCommand(null);
      saveQueue.current = saveQueue.current
        .catch(() => undefined)
        .then(async () => {
          try {
            await storageClient.updateLessonProgress(storageLessonId, command);
          } catch (reason) {
            setFailedCommand(command);
            setProgressError(
              reason instanceof Error
                ? `Chưa lưu tiến độ: ${reason.message}`
                : "Chưa lưu được tiến độ.",
            );
          }
        });
    },
    [lesson, storageLessonId],
  );

  const reviewedItemIds = new Set(
    lesson.vocabulary
      .filter((item) => progress.learningItems[item.id]?.status === "learned")
      .map((item) => item.id),
  );

  const handleReviewWord = useCallback(
    (itemId: string) => {
      if (progress.learningItems[itemId]?.status !== "learned") {
        persistCommand({ type: "mark_learning_item_reviewed", itemId });
      }
    },
    [persistCommand, progress.learningItems],
  );

  const handleAnswerQuestion = useCallback(
    (question: Lesson["quiz"][number], selectedAnswer: number) => {
      persistCommand({
        type: "record_quiz_answer",
        itemId: question.id,
        selectedAnswer,
      });
    },
    [persistCommand],
  );

  function selectTab(id: LessonTab) {
    setActiveTab(id);
    if (!progress.visitedSections.includes(id)) {
      persistCommand({ type: "mark_section_visited", section: id });
    }
  }

  function tabProgress(id: LessonTab): { done: number; total: number; visited: boolean } {
    const visited = progress.visitedSections.includes(id);
    switch (id) {
      case "vocabulary":
        return { done: reviewedItemIds.size, total: lesson.vocabulary.length, visited };
      case "quiz":
        return { done: Object.keys(progress.quizItems).length, total: lesson.quiz.length, visited };
      case "idioms":
        return { done: 0, total: lesson.idiomsAndSlang.length, visited };
      case "grammar":
        return { done: 0, total: lesson.exampleSentences.length, visited };
      case "practice": {
        return { done: 0, total: 0, visited };
      }
    }
  }

  const thumbnailUrl = videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : null;
  const videoUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;

  if (speakingOpen)
    return (
      <SpeakingPractice
        lessonId={storageLessonId}
        onExit={() => {
          setSpeakingOpen(false);
          if (returnToListening) {
            setReturnToListening(false);
            setListeningOpen(true);
          }
        }}
      />
    );
  if (listeningOpen)
    return (
      <ListeningPractice
        lessonId={storageLessonId}
        onExit={() => setListeningOpen(false)}
        onOpenSpeaking={() => {
          setReturnToListening(true);
          setListeningOpen(false);
          setSpeakingOpen(true);
        }}
      />
    );
  return (
    <div>
      <header className="mb-8">
        <div className="mb-5 rounded-2xl border-2 border-primary bg-highlight p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="font-extrabold text-heading">Immersion Listening Loop</p>
              <p className="text-sm text-body">{listeningEntry.detail}</p>
              <button
                type="button"
                onClick={() => setListeningOpen(true)}
                className="mt-3 rounded-full bg-primary px-5 py-3 font-extrabold text-white"
              >
                {listeningEntry.label}
              </button>
            </div>
            <div className="border-t border-border pt-4 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
              <p className="font-extrabold text-heading">Guided Speaking Ladder</p>
              <p className="text-sm text-body">{speakingEntry.detail}</p>
              <button
                type="button"
                onClick={() => setSpeakingOpen(true)}
                className="mt-3 rounded-full border-2 border-primary px-5 py-3 font-extrabold text-primary"
              >
                {speakingEntry.label}
              </button>
            </div>
          </div>
        </div>
        {audioProgress && audioProgress.ready < audioProgress.total ? (
          <p role="status" className="mb-3 text-xs font-bold text-muted">
            Đang chuẩn bị âm thanh: {audioProgress.ready}/{audioProgress.total}
            {audioProgress.failed ? ` · ${audioProgress.failed} lỗi` : ""}
          </p>
        ) : null}
        <AudioCacheControls />
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
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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
            <h2 className="text-3xl font-extrabold leading-tight text-heading">{lesson.title}</h2>

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
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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
            const { done, total, visited } = tabProgress(tab.id);
            const isComplete = total > 0 && done >= total;
            const hasItemProgress = tab.id === "vocabulary" || tab.id === "quiz";

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
                {hasItemProgress && total > 0 ? (
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
                ) : visited ? (
                  <span className="ml-2 rounded-full bg-card px-2 py-0.5 text-xs font-bold text-primary">
                    Đã xem
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
        {progressLoading ? (
          <p className="mb-4 text-sm font-bold text-muted">Đang tải tiến độ học...</p>
        ) : null}
        {progressError ? (
          <div
            role="alert"
            className="mb-4 rounded-xl border-2 border-wrong bg-wrong-light p-3 text-sm font-bold text-wrong"
          >
            {progressError} Tiến độ trên màn hình vẫn được giữ.{" "}
            {failedCommand ? (
              <button
                type="button"
                className="underline"
                onClick={() => persistCommand(failedCommand, false)}
              >
                Thử lại
              </button>
            ) : null}
          </div>
        ) : null}
        {activeTab === "vocabulary" ? (
          <VocabularyCards
            items={lesson.vocabulary}
            reviewedItemIds={reviewedItemIds}
            onReview={handleReviewWord}
          />
        ) : null}

        {activeTab === "idioms" ? <IdiomsSection items={lesson.idiomsAndSlang} /> : null}

        {activeTab === "grammar" ? <GrammarSection items={lesson.exampleSentences} /> : null}

        {activeTab === "practice" ? (
          <DeepPracticeSection
            key={storageLessonId}
            practice={lesson.deepPractice}
            lessonTitle={lesson.title}
            exampleSentences={lesson.exampleSentences}
            practiceHistory={progress.practiceHistory}
            onPracticeComplete={(record) =>
              persistCommand({ type: "append_practice_history", record })
            }
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
