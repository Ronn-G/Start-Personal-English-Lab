"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import LessonDisplay from "@/components/LessonDisplay";
import LegacyMigrationPanel from "@/components/LegacyMigrationPanel";
import BackupRestorePanel from "@/components/BackupRestorePanel";
import ThemeSwitcher from "@/components/ThemeSwitcher";
import SpeakButton from "@/components/lesson/SpeakButton";
import { buildLessonPrompt } from "@/lib/lesson-prompt";
import { formatLessonDiagnostics, parseLessonText } from "@/lib/lesson-schema";
import { storageClient } from "@/lib/storage-client";
import type { LessonSummary } from "@/server/storage/domain";
import type { GenerateLessonResponse, Lesson } from "@/types/lesson";

const EXAMPLE_TRANSCRIPT = `Today I want to talk about how to build a consistent English learning habit.
The biggest mistake people make is trying to study for three hours once a week.
It is much better to spend twenty minutes every day listening, repeating, and writing down useful phrases.
When you hear a phrase in context, do not only translate it. Try to make your own sentence with it.
Over time, these small daily actions compound and your English becomes more natural.`;

function buildChatGptPrompt(transcript: string): string {
  return buildLessonPrompt(transcript);
}

function parsePastedLesson(rawJson: string): Lesson {
  const result = parseLessonText(rawJson);
  if (!result.success || !result.data) throw new Error(formatLessonDiagnostics(result));
  return result.data;
}

interface ListeningDashboardData {
  active: {
    lessonId: string;
    title: string;
    currentStep: string;
    updatedAt: string;
  } | null;
  review: Array<{
    lessonId: string;
    title: string;
    itemId: string;
    sourceType: string;
    sourceItemId: string;
    text: string;
    targetPhrase?: string;
  }>;
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
  const [savedLessons, setSavedLessons] = useState<LessonSummary[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [openSpeakingOnLoad, setOpenSpeakingOnLoad] = useState(false);
  const [openListeningOnLoad, setOpenListeningOnLoad] = useState(false);
  const [listeningDashboard, setListeningDashboard] = useState<ListeningDashboardData | null>(null);
  const [removingRelistenId, setRemovingRelistenId] = useState<string | null>(null);
  const saveInFlight = useRef(false);

  const prompt = useMemo(() => buildChatGptPrompt(transcript.trim()), [transcript]);
  const refreshLibrary = useCallback(async () => {
    setLibraryLoading(true);
    setLibraryError(null);
    try {
      setSavedLessons(await storageClient.listLessons());
    } catch (reason) {
      setLibraryError(reason instanceof Error ? reason.message : "Không thể tải thư viện SQLite.");
    } finally {
      setLibraryLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(refreshLibrary);
  }, [refreshLibrary]);
  const refreshListeningDashboard = useCallback(async () => {
    const response = await fetch("/api/listening", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "dashboard" }),
    });
    const body = (await response.json()) as ListeningDashboardData & { error?: string };
    if (!response.ok) throw new Error(body.error ?? "Could not load saved listening items.");
    setListeningDashboard(body);
    return body;
  }, []);
  useEffect(() => {
    void Promise.resolve()
      .then(refreshListeningDashboard)
      .catch(() => undefined);
  }, [activeSavedId, refreshListeningDashboard]);

  async function showLesson(data: GenerateLessonResponse) {
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true);
    try {
      const saved = await storageClient.createLesson({
        id: data.lesson.id,
        lesson: data.lesson,
        source: transcript.trim() ? { originalTranscript: transcript.trim() } : undefined,
      });
      setOpenSpeakingOnLoad(false);
      setOpenListeningOnLoad(false);
      setResult({ lesson: saved.lesson, videoId: data.videoId });
      setActiveSavedId(saved.id);
      setSaveNotice("Đã lưu bài học vào SQLite.");
      await refreshLibrary();
      window.setTimeout(() => setSaveNotice(null), 2200);
    } catch (reason) {
      setResult(data);
      setActiveSavedId(undefined);
      setError(
        reason instanceof Error
          ? reason.message
          : "Không thể lưu bài học; nội dung đang nhập vẫn được giữ.",
      );
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }

  async function loadSavedLesson(
    savedLesson: LessonSummary,
    openSpeaking = false,
    openListening = false,
  ) {
    setError(null);
    try {
      const stored = await storageClient.getLesson(savedLesson.id);
      setOpenSpeakingOnLoad(openSpeaking);
      setOpenListeningOnLoad(openListening);
      setResult({ lesson: stored.lesson });
      setActiveSavedId(stored.id);
      setSaveNotice("Đã mở bài học từ SQLite.");
      window.setTimeout(() => setSaveNotice(null), 1800);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Không thể mở bài học.");
    }
  }
  async function practiceSpeaking() {
    setError(null);
    try {
      const response = await fetch("/api/speaking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "daily" }),
      });
      const data = (await response.json()) as { lessonId: string | null };
      if (!data.lessonId) {
        setError("Create a lesson with standalone English sentences before practicing speaking.");
        return;
      }
      const selected = savedLessons.find((x) => x.id === data.lessonId);
      if (selected) await loadSavedLesson(selected, true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not choose a speaking lesson.");
    }
  }
  async function practiceListening(preferredLessonId?: string) {
    setError(null);
    try {
      const response = await fetch("/api/listening", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dashboard" }),
      });
      const dashboard = (await response.json()) as ListeningDashboardData & { error?: string };
      if (!response.ok) throw new Error(dashboard.error ?? "Could not choose a listening lesson.");
      setListeningDashboard(dashboard);
      const lessonId = preferredLessonId ?? dashboard.active?.lessonId ?? savedLessons.at(0)?.id;
      const selected = savedLessons.find((lesson) => lesson.id === lessonId);
      if (!selected) {
        setError("Create a lesson with practice sentences before listening.");
        return;
      }
      await loadSavedLesson(selected, false, true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not choose a listening lesson.");
    }
  }

  async function removeSavedSentence(item: ListeningDashboardData["review"][number]) {
    setRemovingRelistenId(item.itemId);
    setError(null);
    try {
      const response = await fetch("/api/listening", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set_saved_for_relisten",
          lessonId: item.lessonId,
          itemId: item.itemId,
          saved: false,
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not remove the saved sentence.");
      await refreshListeningDashboard();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not remove the saved sentence.");
    } finally {
      setRemovingRelistenId(null);
    }
  }

  async function deleteSavedLesson(id: string) {
    const confirmed = window.confirm(
      "Bạn có chắc muốn xóa bài học này không?\n\nBài học sẽ bị xóa khỏi danh sách và tiến độ liên quan sẽ không còn hiển thị trong ứng dụng.",
    );
    if (!confirmed) return;

    setError(null);
    try {
      await storageClient.deleteLesson(id);
      if (activeSavedId === id) {
        setActiveSavedId(undefined);
        setResult(null);
      }
      await refreshLibrary();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Không thể xóa bài học.");
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

      await showLesson(data);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Không thể tạo bài học.");
    } finally {
      setLoading(false);
    }
  }

  async function handleJsonSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    try {
      setError(null);
      const lesson = parsePastedLesson(chatGptJson);
      await showLesson({ lesson });
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
          <div className="flex items-center gap-3">
            <Image
              src="/app-logo.png"
              alt="Logo Personal English Lab"
              width={64}
              height={64}
              priority
              className="size-14 shrink-0 object-contain sm:size-16"
            />
            <p className="text-sm font-extrabold uppercase tracking-[0.12em] text-primary">
              Personal English Lab
            </p>
          </div>
          <ThemeSwitcher />
        </div>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-heading sm:text-4xl">
              Tạo bài học bằng ChatGPT Plus
            </h1>
            <p className="mt-3 max-w-2xl text-base leading-7 text-body">
              Copy transcript để tạo bài tự động bằng Gemini API Free, hoặc dùng luồng thủ công với
              ChatGPT/Gemini nếu bạn muốn tự copy JSON.
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
      <BackupRestorePanel lessonCount={savedLessons.length} onImported={refreshLibrary} />

      <LegacyMigrationPanel onMigrated={refreshLibrary} />

      {libraryLoading ? (
        <p className="rounded-2xl border-2 border-dashed border-border bg-card p-5 text-sm font-bold text-body">
          Đang tải thư viện SQLite...
        </p>
      ) : null}
      {libraryError ? (
        <div
          role="alert"
          className="rounded-2xl border-2 border-wrong bg-wrong-light p-5 text-sm font-bold text-wrong"
        >
          {libraryError}{" "}
          <button type="button" onClick={refreshLibrary} className="ml-2 underline">
            Thử lại
          </button>
        </div>
      ) : null}

      {!libraryLoading && !libraryError && savedLessons.length > 0 ? (
        <section className="rounded-2xl border-2 border-border bg-card p-5 shadow-sm sm:p-6">
          <div className="mb-5 grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => void practiceListening()}
              className="rounded-2xl bg-primary px-5 py-4 text-left font-extrabold text-white"
            >
              {listeningDashboard?.active ? "Continue Listening" : "Start Listening"}
              <span className="block text-xs font-medium opacity-80">
                {listeningDashboard?.active
                  ? `${listeningDashboard.active.title} · progress saved`
                  : "Listen first, then check meaning and review sentences."}
              </span>
            </button>
            <button
              type="button"
              onClick={() => void practiceSpeaking()}
              className="rounded-2xl border-2 border-primary px-5 py-4 text-left font-extrabold text-primary"
            >
              Practice Speaking
              <span className="block text-xs font-medium opacity-80">
                Continue an active session or practice the lesson that needs it most.
              </span>
            </button>
          </div>
          {listeningDashboard?.review.length ? (
            <div className="mb-5 rounded-2xl bg-highlight p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="font-extrabold text-heading">Re-listen</h2>
                  <p className="text-xs text-muted">Sentences you explicitly saved for later.</p>
                </div>
              </div>
              <div className="mt-3 grid gap-2">
                {listeningDashboard.review.slice(0, 5).map((item) => (
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
                        onClick={() => void practiceListening(item.lessonId)}
                        className="rounded-full border-2 border-primary px-3 py-2 text-xs font-extrabold text-primary"
                      >
                        Open lesson
                      </button>
                      <button
                        type="button"
                        disabled={removingRelistenId === item.itemId}
                        onClick={() => void removeSavedSentence(item)}
                        className="rounded-full border-2 border-border px-3 py-2 text-xs font-extrabold text-body disabled:cursor-wait disabled:opacity-50"
                      >
                        {removingRelistenId === item.itemId
                          ? "Removing..."
                          : "Remove from re-listen"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-lg font-extrabold text-heading">Bài học đã lưu</h2>
              <p className="mt-1 text-sm leading-6 text-body">
                Bài mới tạo được lưu trong SQLite cục bộ, kèm tiến độ quiz.
              </p>
            </div>
            <span className="text-xs font-bold text-muted">{savedLessons.length} bài</span>
          </div>

          <div className="mt-4 grid gap-3">
            {savedLessons.map((savedLesson) => (
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
                    <h3 className="font-extrabold leading-6 text-heading">{savedLesson.title}</h3>
                    <p className="mt-1 text-xs font-bold text-muted">
                      Lưu lúc {new Date(savedLesson.updatedAt).toLocaleString("vi-VN")}
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
      {!libraryLoading && !libraryError && savedLessons.length === 0 ? (
        <p className="rounded-2xl border-2 border-border bg-card p-5 text-sm text-body">
          Thư viện SQLite chưa có bài học. Bạn có thể tạo bài mới hoặc chuyển dữ liệu cũ.
        </p>
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
            disabled={saving || !chatGptJson.trim()}
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
            disabled={loading || saving || !transcript.trim()}
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
          {result && !activeSavedId ? (
            <button
              type="button"
              disabled={saving}
              onClick={() => void showLesson(result)}
              className="ml-3 underline disabled:opacity-50"
            >
              Thử lưu lại
            </button>
          ) : null}
        </div>
      ) : null}

      {saveNotice ? (
        <div className="rounded-2xl border-2 border-correct bg-correct-light px-5 py-4 text-sm font-bold text-heading">
          {saveNotice}
        </div>
      ) : null}

      {loading ? (
        <div className="rounded-2xl border-2 border-dashed border-border bg-highlight px-6 py-16 text-center">
          <p className="text-lg font-extrabold text-heading">Đang tạo bài học...</p>
          <p className="mt-2 text-sm text-body">
            Thường mất khoảng 20-40 giây, tùy độ dài transcript.
          </p>
        </div>
      ) : null}

      {result ? (
        <section className="rounded-2xl border-2 border-border bg-card p-5 shadow-sm sm:p-6">
          <LessonDisplay
            key={`${activeSavedId ?? result.lesson.title}-${
              openListeningOnLoad ? "listening" : openSpeakingOnLoad ? "speaking" : "lesson"
            }`}
            lesson={result.lesson}
            lessonId={activeSavedId}
            videoId={result.videoId}
            initialSpeakingOpen={openSpeakingOnLoad}
            initialListeningOpen={openListeningOnLoad}
          />
        </section>
      ) : null}
    </div>
  );
}
