"use client";

import { useMemo, useState, useSyncExternalStore } from "react";

import LessonDisplay from "@/components/LessonDisplay";
import ThemeSwitcher from "@/components/ThemeSwitcher";
import { buildLessonPrompt } from "@/lib/lesson-prompt";
import { formatLessonDiagnostics, parseLessonText } from "@/lib/lesson-schema";
import type { GenerateLessonResponse, Lesson } from "@/types/lesson";

const EXAMPLE_TRANSCRIPT = `Today I want to talk about how to build a consistent English learning habit.
The biggest mistake people make is trying to study for three hours once a week.
It is much better to spend twenty minutes every day listening, repeating, and writing down useful phrases.
When you hear a phrase in context, do not only translate it. Try to make your own sentence with it.
Over time, these small daily actions compound and your English becomes more natural.`;

const SAVED_LESSONS_KEY = "personal-english-lab-saved-lessons";
const SAVED_LESSONS_EVENT = "personal-english-lab-saved-lessons-change";
const MAX_SAVED_LESSONS = 30;

interface SavedLesson {
  id: string;
  lesson: Lesson;
  videoId?: string;
  createdAt: string;
  updatedAt: string;
}

function createSavedLessonId() {
  return `lesson-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function readSavedLessons(): SavedLesson[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(SAVED_LESSONS_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as SavedLesson[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSavedLessons(lessons: SavedLesson[]) {
  window.localStorage.setItem(
    SAVED_LESSONS_KEY,
    JSON.stringify(lessons.slice(0, MAX_SAVED_LESSONS)),
  );
  window.dispatchEvent(new Event(SAVED_LESSONS_EVENT));
}

function subscribeSavedLessons(onStoreChange: () => void) {
  window.addEventListener(SAVED_LESSONS_EVENT, onStoreChange);
  window.addEventListener("storage", onStoreChange);

  return () => {
    window.removeEventListener(SAVED_LESSONS_EVENT, onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

function getSavedLessonsSnapshot() {
  return JSON.stringify(readSavedLessons());
}

function getServerSavedLessonsSnapshot() {
  return "[]";
}

function buildChatGptPrompt(transcript: string): string {
  return buildLessonPrompt(transcript);
}


function parsePastedLesson(rawJson: string): Lesson {
  const result = parseLessonText(rawJson);
  if (!result.success || !result.data) throw new Error(formatLessonDiagnostics(result));
  return result.data;
}

export default function LessonGenerator() {
  const [transcript, setTranscript] = useState("");
  const [chatGptJson, setChatGptJson] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GenerateLessonResponse | null>(null);
  const [activeSavedId, setActiveSavedId] = useState<string | undefined>();
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  const prompt = useMemo(() => buildChatGptPrompt(transcript.trim()), [transcript]);
  const savedLessonsSnapshot = useSyncExternalStore(
    subscribeSavedLessons,
    getSavedLessonsSnapshot,
    getServerSavedLessonsSnapshot,
  );
  const savedLessons = useMemo(
    () => JSON.parse(savedLessonsSnapshot) as SavedLesson[],
    [savedLessonsSnapshot],
  );

  function persistLesson(data: GenerateLessonResponse): string {
    const now = new Date().toISOString();
    const duplicate = savedLessons.find(
      (item) =>
        item.lesson.title === data.lesson.title &&
        item.lesson.summary === data.lesson.summary,
    );

    const savedLesson: SavedLesson = {
      id: duplicate?.id ?? createSavedLessonId(),
      lesson: data.lesson,
      videoId: data.videoId,
      createdAt: duplicate?.createdAt ?? now,
      updatedAt: now,
    };

    const next = [
      savedLesson,
      ...savedLessons.filter((item) => item.id !== savedLesson.id),
    ].slice(0, MAX_SAVED_LESSONS);

    writeSavedLessons(next);
    setActiveSavedId(savedLesson.id);
    setSaveNotice("Đã lưu bài học vào thư viện.");
    window.setTimeout(() => setSaveNotice(null), 2200);

    return savedLesson.id;
  }

  function showLesson(data: GenerateLessonResponse) {
    const savedId = persistLesson(data);
    setResult(data);
    setActiveSavedId(savedId);
  }

  function loadSavedLesson(savedLesson: SavedLesson) {
    setResult({
      lesson: savedLesson.lesson,
      videoId: savedLesson.videoId,
    });
    setActiveSavedId(savedLesson.id);
    setError(null);
    setSaveNotice("Đã mở bài học đã lưu.");
    window.setTimeout(() => setSaveNotice(null), 1800);
  }

  function deleteSavedLesson(id: string) {
    const next = savedLessons.filter((item) => item.id !== id);
    writeSavedLessons(next);

    if (activeSavedId === id) {
      setActiveSavedId(undefined);
    }
  }

  async function copyPrompt() {
    const cleanedTranscript = transcript.trim();
    if (!cleanedTranscript) {
      setError("Bạn hãy dán transcript tiếng Anh trước.");
      return;
    }

    await navigator.clipboard.writeText(buildChatGptPrompt(cleanedTranscript));
    setCopied(true);
    setError(null);
    window.setTimeout(() => setCopied(false), 1800);
  }

  async function handleApiSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const cleanedTranscript = transcript.trim();
    if (!cleanedTranscript) {
      setError("Bạn hãy dán transcript tiếng Anh trước.");
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch("/api/generate-lesson", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: cleanedTranscript }),
      });

      const data = (await response.json()) as GenerateLessonResponse & {
        error?: string;
      };

      if (!response.ok) {
        throw new Error(data.error ?? "Không thể tạo bài học.");
      }

      showLesson(data);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Không thể tạo bài học.",
      );
    } finally {
      setLoading(false);
    }
  }

  function handleJsonSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    try {
      const lesson = parsePastedLesson(chatGptJson);
      showLesson({ lesson });
      setError(null);
    } catch (parseError) {
      setError(
        parseError instanceof Error
          ? `Không đọc được JSON: ${parseError.message}`
          : "Không đọc được JSON từ ChatGPT.",
      );
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-8 px-5 py-8 sm:px-6 lg:py-10">
      <header className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <p className="pt-2 text-sm font-extrabold uppercase tracking-[0.12em] text-primary">
            Personal English Lab
          </p>
          <ThemeSwitcher />
        </div>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-heading sm:text-4xl">
              Tạo bài học bằng ChatGPT Plus
            </h1>
            <p className="mt-3 max-w-2xl text-base leading-7 text-body">
              Copy transcript để tạo bài tự động bằng Gemini API Free, hoặc dùng
              luồng thủ công với ChatGPT/Gemini nếu bạn muốn tự copy JSON.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setTranscript(EXAMPLE_TRANSCRIPT)}
            className="w-fit rounded-xl border-2 border-border bg-card px-4 py-3 text-sm font-extrabold text-primary shadow-sm transition ease-smooth hover:border-primary hover:bg-highlight"
          >
            Dùng transcript mẫu
          </button>
        </div>
      </header>

      {savedLessons.length > 0 ? (
        <section className="rounded-2xl border-2 border-border bg-card p-5 shadow-sm sm:p-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-lg font-extrabold text-heading">
                Bài học đã lưu
              </h2>
              <p className="mt-1 text-sm leading-6 text-body">
                Bài mới tạo sẽ tự lưu trên trình duyệt này, kèm tiến độ từ vựng và quiz.
              </p>
            </div>
            <span className="text-xs font-bold text-muted">
              {savedLessons.length}/{MAX_SAVED_LESSONS} bài
            </span>
          </div>

          <div className="mt-4 grid gap-3">
            {savedLessons.slice(0, 5).map((savedLesson) => (
              <article
                key={savedLesson.id}
                className={`rounded-xl border-2 p-4 transition ease-smooth ${
                  activeSavedId === savedLesson.id
                    ? "border-primary bg-highlight"
                    : "border-border bg-background"
                }`}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h3 className="font-extrabold leading-6 text-heading">
                      {savedLesson.lesson.title}
                    </h3>
                    <p className="mt-1 text-xs font-bold text-muted">
                      Lưu lúc{" "}
                      {new Date(savedLesson.updatedAt).toLocaleString("vi-VN")}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => loadSavedLesson(savedLesson)}
                      className="rounded-full border-2 border-primary bg-card px-4 py-2 text-xs font-extrabold uppercase tracking-wide text-primary transition ease-smooth hover:bg-white"
                    >
                      Mở
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteSavedLesson(savedLesson.id)}
                      className="rounded-full border-2 border-border bg-card px-4 py-2 text-xs font-extrabold uppercase tracking-wide text-body transition ease-smooth hover:border-wrong hover:text-wrong"
                    >
                      Xóa
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section className="rounded-2xl border-2 border-border bg-card p-5 shadow-sm sm:p-6">
        <div className="flex items-center justify-between gap-4">
          <label
            htmlFor="transcript"
            className="text-sm font-extrabold uppercase tracking-wide text-body"
          >
            1. Transcript
          </label>
          <span className="text-xs font-bold text-muted">
            {transcript.trim().length.toLocaleString("vi-VN")} ký tự
          </span>
        </div>

        <textarea
          id="transcript"
          value={transcript}
          onChange={(event) => setTranscript(event.target.value)}
          placeholder="Dán transcript tiếng Anh từ YouTube vào đây..."
          className="mt-4 min-h-[240px] w-full resize-y rounded-2xl border-2 border-border bg-background px-4 py-4 text-base leading-7 text-heading outline-none placeholder:text-muted transition ease-smooth focus:border-primary"
        />

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm leading-6 text-body">
            Luồng không cần API: copy prompt, gửi vào ChatGPT Plus, rồi dán JSON bên dưới.
          </p>
          <button
            type="button"
            onClick={copyPrompt}
            disabled={!transcript.trim()}
            className="button-depth rounded-2xl bg-accent px-8 py-4 text-base font-extrabold uppercase tracking-wide text-accent-foreground transition ease-smooth hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none active:translate-y-0.5"
          >
            {copied ? "Đã copy prompt" : "Copy prompt cho ChatGPT"}
          </button>
        </div>

        <details className="mt-5 rounded-2xl border-2 border-border bg-background p-4">
          <summary className="cursor-pointer text-sm font-extrabold text-primary">
            Xem prompt sẽ gửi sang ChatGPT
          </summary>
          <pre className="mt-4 max-h-[320px] overflow-auto whitespace-pre-wrap rounded-xl bg-card p-4 text-xs leading-5 text-body">
            {prompt}
          </pre>
        </details>
      </section>

      <form
        onSubmit={handleJsonSubmit}
        className="rounded-2xl border-2 border-border bg-card p-5 shadow-sm sm:p-6"
      >
        <label
          htmlFor="chatgpt-json"
          className="text-sm font-extrabold uppercase tracking-wide text-body"
        >
          2. Dán JSON từ ChatGPT
        </label>
        <textarea
          id="chatgpt-json"
          value={chatGptJson}
          onChange={(event) => setChatGptJson(event.target.value)}
          placeholder="Dán toàn bộ JSON ChatGPT trả về vào đây..."
          className="mt-4 min-h-[220px] w-full resize-y rounded-2xl border-2 border-border bg-background px-4 py-4 font-mono text-sm leading-6 text-heading outline-none placeholder:text-muted transition ease-smooth focus:border-primary"
        />

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm leading-6 text-body">
            Nếu ChatGPT bọc trong ```json, app vẫn tự bỏ phần đó khi đọc.
          </p>
          <button
            type="submit"
            disabled={!chatGptJson.trim()}
            className="button-depth rounded-2xl bg-accent px-8 py-4 text-base font-extrabold uppercase tracking-wide text-accent-foreground transition ease-smooth hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none active:translate-y-0.5"
          >
            Hiển thị bài học
          </button>
        </div>
      </form>

      <form
        onSubmit={handleApiSubmit}
        className="rounded-2xl border-2 border-dashed border-border bg-highlight p-5 sm:p-6"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-extrabold text-heading">
              Tạo tự động bằng Gemini API Free
            </h2>
            <p className="mt-1 text-sm leading-6 text-body">
              Dùng API key miễn phí từ Google AI Studio trong file .env.local.
            </p>
          </div>
          <button
            type="submit"
            disabled={loading || !transcript.trim()}
            className="rounded-2xl border-2 border-primary bg-card px-6 py-3 text-sm font-extrabold uppercase tracking-wide text-primary transition ease-smooth hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Đang tạo..." : "Tạo bằng Gemini"}
          </button>
        </div>
      </form>

      {error ? (
        <div
          role="alert"
          className="rounded-2xl border-2 border-wrong bg-wrong-light px-5 py-4 text-sm font-bold text-wrong"
        >
          {error}
        </div>
      ) : null}

      {saveNotice ? (
        <div className="rounded-2xl border-2 border-correct bg-correct-light px-5 py-4 text-sm font-bold text-heading">
          {saveNotice}
        </div>
      ) : null}

      {loading ? (
        <div className="rounded-2xl border-2 border-dashed border-border bg-highlight px-6 py-16 text-center">
          <p className="text-lg font-extrabold text-heading">
            Đang tạo bài học...
          </p>
          <p className="mt-2 text-sm text-body">
            Thường mất khoảng 20-40 giây, tùy độ dài transcript.
          </p>
        </div>
      ) : null}

      {result ? (
        <section className="rounded-2xl border-2 border-border bg-card p-5 shadow-sm sm:p-6">
          <LessonDisplay
            key={activeSavedId ?? result.lesson.title}
            lesson={result.lesson}
            lessonId={activeSavedId}
            videoId={result.videoId}
          />
        </section>
      ) : null}
    </div>
  );
}
