"use client";

import { useMemo, useState } from "react";

import SpeakButton from "@/components/lesson/SpeakButton";
import type { PracticeHistoryItem } from "@/lib/lesson-progress";
import type { ExampleSentence, PracticeFeedbackResponse } from "@/types/lesson";

interface ActivePracticeSectionProps {
  lessonTitle: string;
  prompts: ExampleSentence[];
  history: PracticeHistoryItem[];
  onComplete: (record: PracticeHistoryItem) => void;
}

type PracticeMode = "writing" | "speaking";

type SpeechRecognitionConstructor = new () => SpeechRecognition;

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

interface SpeechRecognitionEvent {
  results: {
    length: number;
    [index: number]: {
      [index: number]: {
        transcript: string;
      };
    };
  };
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

export default function ActivePracticeSection({
  lessonTitle,
  prompts,
  history,
  onComplete,
}: ActivePracticeSectionProps) {
  const [mode, setMode] = useState<PracticeMode>("writing");
  const [promptIndex, setPromptIndex] = useState(0);
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<PracticeFeedbackResponse["feedback"] | null>(null);

  const currentPrompt = prompts[promptIndex];
  const speechSupported = useMemo(() => {
    if (typeof window === "undefined") {
      return false;
    }

    return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  }, []);

  async function requestFeedback() {
    if (!currentPrompt || !answer.trim()) {
      setError("Hãy viết hoặc nói một câu trước khi xin phản hồi.");
      return;
    }

    setLoading(true);
    setError(null);
    setFeedback(null);

    try {
      const response = await fetch("/api/practice-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          lessonTitle,
          target: currentPrompt.sentence,
          answer: answer.trim(),
        }),
      });

      const data = (await response.json()) as PracticeFeedbackResponse & {
        error?: string;
      };

      if (!response.ok) {
        throw new Error(data.error ?? "Không thể tạo phản hồi.");
      }

      setFeedback(data.feedback);
      onComplete({
        id: crypto.randomUUID(),
        itemId: currentPrompt.id,
        mode,
        prompt: currentPrompt.sentence,
        userAnswer: answer.trim(),
        feedback: data.feedback,
        occurredAt: new Date().toISOString(),
      });
    } catch (feedbackError) {
      setError(feedbackError instanceof Error ? feedbackError.message : "Không thể tạo phản hồi.");
    } finally {
      setLoading(false);
    }
  }

  function startSpeechPractice() {
    const SpeechApi = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechApi) {
      setError(
        "Trình duyệt này chưa hỗ trợ ghi âm thành chữ. Bạn có thể gõ câu nói của mình vào ô bên dưới.",
      );
      return;
    }

    const recognition = new SpeechApi();
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const transcript = Array.from({ length: event.results.length })
        .map((_, index) => event.results[index][0].transcript)
        .join(" ")
        .trim();

      setAnswer(transcript);
      setError(null);
    };
    recognition.onerror = () => {
      setError("Không nghe được giọng nói. Hãy thử lại hoặc gõ câu trả lời.");
      setListening(false);
    };
    recognition.onend = () => setListening(false);
    recognition.start();
    setListening(true);
  }

  if (prompts.length === 0) {
    return null;
  }

  return (
    <section className="rounded-2xl border-2 border-border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-xl font-extrabold text-heading">Luyện viết và nói có phản hồi</h3>
          <p className="mt-2 text-sm leading-6 text-body">
            Chọn một câu mẫu, tự viết hoặc nói lại theo ý của bạn, rồi nhận góp ý.
          </p>
        </div>

        <div className="inline-flex rounded-full border-2 border-border bg-highlight p-1">
          {(["writing", "speaking"] as PracticeMode[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => {
                setMode(item);
                setFeedback(null);
                setError(null);
              }}
              className={`rounded-full px-4 py-2 text-xs font-extrabold uppercase tracking-wide transition ease-smooth ${
                mode === item ? "bg-primary text-white shadow-sm" : "text-primary hover:bg-card"
              }`}
            >
              {item === "writing" ? "Viết" : "Nói"}
            </button>
          ))}
        </div>
      </div>

      <label
        htmlFor="practice-prompt"
        className="mt-5 block text-xs font-extrabold uppercase tracking-wide text-body"
      >
        Câu mẫu
      </label>
      <select
        id="practice-prompt"
        value={promptIndex}
        onChange={(event) => {
          setPromptIndex(Number(event.target.value));
          setFeedback(null);
          setError(null);
        }}
        className="mt-2 w-full rounded-xl border-2 border-border bg-background px-4 py-3 text-sm font-bold text-heading outline-none transition ease-smooth focus:border-primary"
      >
        {prompts.map((prompt, index) => (
          <option key={`${prompt.sentence}-${index}`} value={index}>
            {prompt.sentence}
          </option>
        ))}
      </select>

      <div className="mt-4 rounded-xl bg-highlight p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="text-base font-bold leading-7 text-heading">{currentPrompt.sentence}</p>
          <SpeakButton text={currentPrompt.sentence} label="Nghe mẫu" rate={0.82} />
        </div>
        <p className="mt-2 text-sm font-bold leading-6 text-translation">
          {currentPrompt.vietnamese}
        </p>
      </div>

      <label
        htmlFor="practice-answer"
        className="mt-5 block text-xs font-extrabold uppercase tracking-wide text-body"
      >
        Câu của bạn
      </label>
      <textarea
        id="practice-answer"
        value={answer}
        onChange={(event) => {
          setAnswer(event.target.value);
          setFeedback(null);
        }}
        placeholder={
          mode === "writing"
            ? "Viết một câu tương tự bằng tiếng Anh..."
            : "Bấm ghi âm hoặc gõ lại câu bạn vừa nói..."
        }
        className="mt-2 min-h-[120px] w-full resize-y rounded-xl border-2 border-border bg-background px-4 py-3 text-base leading-7 text-heading outline-none placeholder:text-muted transition ease-smooth focus:border-primary"
      />

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          {mode === "speaking" ? (
            <button
              type="button"
              onClick={startSpeechPractice}
              disabled={listening || !speechSupported}
              className="rounded-full border-2 border-primary bg-card px-4 py-2 text-sm font-extrabold text-primary transition ease-smooth hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {listening ? "Đang nghe..." : "Ghi âm câu nói"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setAnswer("");
              setFeedback(null);
              setError(null);
            }}
            className="rounded-full border-2 border-border bg-card px-4 py-2 text-sm font-extrabold text-body transition ease-smooth hover:border-primary hover:text-primary"
          >
            Xóa câu
          </button>
        </div>

        <button
          type="button"
          onClick={requestFeedback}
          disabled={loading || !answer.trim()}
          className="button-depth rounded-2xl bg-accent px-6 py-3 text-sm font-extrabold uppercase tracking-wide text-accent-foreground transition ease-smooth hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none active:translate-y-0.5"
        >
          {loading ? "Đang chấm..." : "Nhận phản hồi"}
        </button>
      </div>

      {!speechSupported && mode === "speaking" ? (
        <p className="mt-3 text-xs font-bold text-muted">
          Trình duyệt chưa hỗ trợ ghi âm thành chữ, nhưng bạn vẫn có thể gõ câu đã nói để nhận phản
          hồi.
        </p>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="mt-4 rounded-xl border-2 border-wrong bg-wrong-light px-4 py-3 text-sm font-bold text-wrong"
        >
          {error}
        </div>
      ) : null}

      {feedback ? (
        <div className="mt-5 rounded-2xl border-2 border-border bg-background p-5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <h4 className="text-lg font-extrabold text-heading">Phản hồi của coach</h4>
            <span className="w-fit rounded-full bg-correct-light px-3 py-1 text-sm font-extrabold text-primary">
              {feedback.score}/10
            </span>
          </div>
          <p className="mt-3 text-sm leading-6 text-body">{feedback.overall}</p>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl bg-card p-4">
              <p className="text-sm font-extrabold text-heading">Điểm tốt</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-body">
                {feedback.strengths.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div className="rounded-xl bg-card p-4">
              <p className="text-sm font-extrabold text-heading">Cần sửa</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-body">
                {feedback.corrections.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </div>

          <div className="mt-4 rounded-xl bg-card p-4">
            <p className="text-sm font-extrabold text-heading">Câu tự nhiên hơn</p>
            <p className="mt-2 text-base font-bold leading-7 text-primary">
              {feedback.improvedVersion}
            </p>
            <div className="mt-3">
              <SpeakButton text={feedback.improvedVersion} label="Nghe câu sửa" rate={0.82} />
            </div>
          </div>

          <p className="mt-4 rounded-xl bg-highlight p-4 text-sm font-bold leading-6 text-heading">
            {feedback.nextStep}
          </p>
        </div>
      ) : null}

      <div className="mt-6 border-t-2 border-border pt-5">
        <h4 className="text-lg font-extrabold text-heading">Lịch sử gần đây</h4>
        {history.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Chưa có bài luyện nào được lưu.</p>
        ) : (
          <div className="mt-3 space-y-3">
            {history.slice(0, 5).map((item) => (
              <details
                key={item.id}
                className="rounded-xl border-2 border-border bg-background p-4"
              >
                <summary className="cursor-pointer text-sm font-extrabold text-heading">
                  {item.mode === "writing" ? "Viết" : "Nói"} ·{" "}
                  {new Date(item.occurredAt).toLocaleString("vi-VN")}
                </summary>
                <p className="mt-3 text-sm font-bold text-heading">{item.prompt}</p>
                <p className="mt-2 text-sm leading-6 text-body">{item.userAnswer}</p>
                <p className="mt-3 text-sm font-bold text-primary">
                  {item.feedback.score}/10 · {item.feedback.overall}
                </p>
                <p className="mt-2 text-sm leading-6 text-body">
                  Câu tự nhiên hơn: {item.feedback.improvedVersion}
                </p>
              </details>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
