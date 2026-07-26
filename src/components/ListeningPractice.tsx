"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { audioClient } from "@/lib/audio-client";
import {
  AUDIO_DEFAULTS,
  rateToKokoroSpeed,
  type AudioPreparationStatus,
  type AudioPreloadItem,
} from "@/lib/audio-domain";
import {
  selectSourceDiverseListeningItems,
  type ComprehensionLevel,
  type FinalRelistenRating,
  type ListeningSourceType,
  type ListeningStep,
} from "@/lib/listening-practice";

interface ListeningProgress {
  listenCount: number;
  loopCount: number;
  transcriptRevealed: boolean;
  recognitionStatus: "not_started" | "heard" | "recognized";
  difficult: boolean;
  lastListenedAt: string | null;
}

interface ListeningItemData {
  id: string;
  lessonId: string;
  sourceType: ListeningSourceType;
  sourceItemId: string;
  text: string;
  targetPhrase?: string;
  meaning?: string;
  sourceContext?: string;
  speakingPracticeItemId?: string;
  progress: ListeningProgress;
}

interface ListeningSessionData {
  id: string;
  lessonId: string;
  status: "active" | "completed" | "cancelled";
  currentStep: ListeningStep;
  firstListenComprehension: ComprehensionLevel | null;
  firstListenNote: string;
  secondListenComprehension: ComprehensionLevel | null;
  finalRelistenRating: FinalRelistenRating | null;
  finalNote: string;
  revealedItemIds: string[];
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface ListeningData {
  lessonId: string;
  lessonTitle: string;
  summary: string;
  track: string;
  session: ListeningSessionData | null;
  items: ListeningItemData[];
  empty: boolean;
}

type Command = (
  action: string,
  extra?: Record<string, unknown>,
  quiet?: boolean,
) => Promise<ListeningData | undefined>;

const comprehensionOptions: Array<{
  value: ComprehensionLevel;
  label: string;
  detail: string;
}> = [
  { value: "mostly_lost", label: "Mostly lost", detail: "I caught very little." },
  { value: "some_parts", label: "Some parts", detail: "I understood a few pieces." },
  { value: "main_idea", label: "Main idea", detail: "I followed the main message." },
  { value: "most_of_it", label: "Most of it", detail: "I understood nearly everything." },
];

const comprehensionLabel = Object.fromEntries(
  comprehensionOptions.map((option) => [option.value, option.label]),
) as Record<ComprehensionLevel, string>;

const stepOrder: ListeningStep[] = [
  "first_listen",
  "check_meaning",
  "second_listen",
  "sentence_review",
  "final_relisten",
];

const stepLabel: Record<ListeningStep, string> = {
  first_listen: "First Listen",
  check_meaning: "Check Meaning",
  second_listen: "Second Listen",
  sentence_review: "Sentence Review",
  final_relisten: "Final Re-listen",
  complete: "Complete",
};

interface PlaybackState {
  itemId: string | null;
  loading: boolean;
  playing: boolean;
  paused: boolean;
  completed: number;
  target: number;
  source?: "kokoro" | "browser";
  error?: string;
}

type ListeningAudioStatus = "idle" | "preparing" | "ready" | "browser" | "failed";

interface ListeningAudioState {
  status: ListeningAudioStatus;
  error?: string;
}

function useListeningPlayback(
  lessonId: string,
  onRecorded: (itemId: string, repetitions: number) => void,
) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const speechRef = useRef<SpeechSynthesisUtterance | null>(null);
  const finishOneRef = useRef<() => void>(() => undefined);
  const runRef = useRef<{
    itemId: string;
    text: string;
    target: number;
    completed: number;
    rate: number;
    recorded: boolean;
  } | null>(null);
  const onRecordedRef = useRef(onRecorded);
  const [state, setState] = useState<PlaybackState>({
    itemId: null,
    loading: false,
    playing: false,
    paused: false,
    completed: 0,
    target: 0,
  });
  const [itemAudio, setItemAudio] = useState<Record<string, ListeningAudioState>>({});
  useEffect(() => {
    onRecordedRef.current = onRecorded;
  }, [onRecorded]);

  const updateItemAudio = useCallback(
    (itemId: string, status: ListeningAudioStatus, error?: string) => {
      setItemAudio((current) => ({
        ...current,
        [itemId]: { status, error },
      }));
    },
    [],
  );

  const recordRun = useCallback(() => {
    const run = runRef.current;
    if (!run || run.recorded || run.itemId === "track" || run.completed === 0) return;
    run.recorded = true;
    onRecordedRef.current(run.itemId, run.completed);
  }, []);

  const stop = useCallback(
    (recordCompleted = true) => {
      audioRef.current?.pause();
      audioRef.current = null;
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
      speechRef.current = null;
      if (recordCompleted) recordRun();
      runRef.current = null;
      setState((current) => ({
        ...current,
        loading: false,
        playing: false,
        paused: false,
      }));
    },
    [recordRun],
  );

  const finishOne = useCallback(() => {
    const run = runRef.current;
    if (!run) return;
    run.completed += 1;
    setState((current) => ({ ...current, completed: run.completed }));
    if (run.completed >= run.target) {
      recordRun();
      runRef.current = null;
      setState((current) => ({ ...current, playing: false, paused: false }));
      return;
    }
    const audio = audioRef.current;
    if (audio) {
      audio.currentTime = 0;
      void audio.play().catch(() =>
        setState((current) => ({
          ...current,
          playing: false,
          error: "Audio playback stopped. Try again.",
        })),
      );
      return;
    }
    if ("speechSynthesis" in window) {
      const utterance = new SpeechSynthesisUtterance(run.text);
      utterance.lang = "en-US";
      utterance.rate = run.rate;
      utterance.onend = () => finishOneRef.current();
      speechRef.current = utterance;
      window.speechSynthesis.speak(utterance);
    }
  }, [recordRun]);
  useEffect(() => {
    finishOneRef.current = finishOne;
  }, [finishOne]);

  const playBrowserFallback = useCallback(
    (run: {
      itemId: string;
      text: string;
      target: number;
      completed: number;
      rate: number;
      recorded: boolean;
    }) => {
      if (!("speechSynthesis" in window) || runRef.current !== run) return false;
      const utterance = new SpeechSynthesisUtterance(run.text);
      utterance.lang = "en-US";
      utterance.rate = run.rate;
      utterance.onend = () => finishOneRef.current();
      utterance.onerror = () => {
        updateItemAudio(run.itemId, "failed", "Browser voice stopped.");
        setState((current) => ({
          ...current,
          loading: false,
          playing: false,
          error: "Browser voice stopped. Try again.",
        }));
      };
      speechRef.current = utterance;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
      setState((current) => ({
        ...current,
        loading: false,
        playing: true,
        source: "browser",
        error: undefined,
      }));
      updateItemAudio(run.itemId, "browser", "Kokoro is unavailable.");
      return true;
    },
    [updateItemAudio],
  );

  const play = useCallback(
    async (itemId: string, text: string, target = 1, rate = 0.86, allowBrowserFallback = true) => {
      stop(true);
      const run = { itemId, text, target, completed: 0, rate, recorded: false };
      runRef.current = run;
      updateItemAudio(itemId, "preparing");
      setState({
        itemId,
        loading: true,
        playing: false,
        paused: false,
        completed: 0,
        target,
      });
      try {
        const url = await audioClient.prepare(text, lessonId, rate);
        if (runRef.current !== run) return;
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => finishOneRef.current();
        audio.onerror = () => {
          if (runRef.current !== run) return;
          audioRef.current = null;
          if (!allowBrowserFallback || !playBrowserFallback(run)) {
            updateItemAudio(itemId, "failed", "Kokoro audio could not play.");
            setState((current) => ({
              ...current,
              loading: false,
              playing: false,
              error: "Kokoro audio could not play. Try again.",
            }));
          }
        };
        await audio.play();
        if (runRef.current !== run) {
          audio.pause();
          return;
        }
        updateItemAudio(itemId, "ready");
        setState((current) => ({
          ...current,
          loading: false,
          playing: true,
          source: "kokoro",
          error: undefined,
        }));
      } catch (reason) {
        if (runRef.current !== run) return;
        const detail = reason instanceof Error ? reason.message : "Kokoro audio failed.";
        if (!allowBrowserFallback || !playBrowserFallback(run)) {
          updateItemAudio(itemId, "failed", detail);
          setState((current) => ({
            ...current,
            loading: false,
            playing: false,
            error: "Audio is unavailable. Check Kokoro and try again.",
          }));
        }
      }
    },
    [lessonId, playBrowserFallback, stop, updateItemAudio],
  );

  const preload = useCallback(
    (
      items: Array<{
        id: string;
        text: string;
        sourceType: ListeningSourceType;
      }>,
      rate: number,
    ) => {
      const speed = rateToKokoroSpeed(rate);
      const preloadItems: AudioPreloadItem[] = items.map((item, index) => ({
        lessonId,
        itemId: item.id,
        text: item.text,
        sourceType: item.sourceType === "sentence_mining" ? "sentence-mining" : item.sourceType,
        priority: index + 1,
        config: { ...AUDIO_DEFAULTS, speed },
      }));
      audioClient.preload(preloadItems, undefined, (item, status: AudioPreparationStatus) => {
        if (status === "queued" || status === "generating") {
          updateItemAudio(item.itemId, "preparing");
        } else if (status === "ready") {
          updateItemAudio(item.itemId, "ready");
        } else if (status === "failed") {
          updateItemAudio(item.itemId, "failed", "Kokoro preparation failed.");
        }
      });
    },
    [lessonId, updateItemAudio],
  );

  const togglePause = useCallback(() => {
    if (!runRef.current) return;
    if (state.paused) {
      if (audioRef.current) void audioRef.current.play();
      else if ("speechSynthesis" in window) window.speechSynthesis.resume();
      setState((current) => ({ ...current, paused: false, playing: true }));
    } else {
      audioRef.current?.pause();
      if ("speechSynthesis" in window) window.speechSynthesis.pause();
      setState((current) => ({ ...current, paused: true, playing: false }));
    }
  }, [state.paused]);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
      runRef.current = null;
      audioClient.cancelLesson(lessonId);
    };
  }, [lessonId]);

  const retryKokoro = useCallback(
    (itemId: string, text: string, rate: number) => play(itemId, text, 1, rate, false),
    [play],
  );

  const audioStatus = useCallback(
    (itemId: string): ListeningAudioState => itemAudio[itemId] ?? { status: "idle" },
    [itemAudio],
  );

  return { state, play, retryKokoro, preload, audioStatus, stop, togglePause };
}

export default function ListeningPractice({
  lessonId,
  onExit,
  onOpenSpeaking,
}: {
  lessonId: string;
  onExit: () => void;
  onOpenSpeaking: () => void;
}) {
  const [data, setData] = useState<ListeningData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const command: Command = async (action, extra = {}, quiet = false) => {
    if (!quiet) setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/listening", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          lessonId,
          sessionId: data?.session?.id,
          ...extra,
        }),
      });
      const body = (await response.json()) as ListeningData & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not save listening progress.");
      setData(body);
      return body;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save listening progress.");
    } finally {
      if (!quiet) setBusy(false);
    }
  };

  useEffect(() => {
    let active = true;
    fetch("/api/listening", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "status", lessonId }),
    })
      .then(async (response) => {
        const body = (await response.json()) as ListeningData & { error?: string };
        if (!response.ok) throw new Error(body.error ?? "Could not load listening practice.");
        if (active) setData(body);
      })
      .catch((reason) => {
        if (active)
          setError(reason instanceof Error ? reason.message : "Could not load listening practice.");
      });
    return () => {
      active = false;
    };
  }, [lessonId]);

  if (!data) {
    return (
      <section className="rounded-3xl border-2 border-border bg-card p-8 text-center">
        <p role={error ? "alert" : "status"} className={error ? "text-wrong" : "text-muted"}>
          {error || "Loading listening practice…"}
        </p>
        {error ? (
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 font-bold text-primary underline"
          >
            Retry
          </button>
        ) : null}
      </section>
    );
  }

  if (data.empty) {
    return (
      <section className="rounded-3xl border-2 border-border bg-card p-8 text-center">
        <h2 className="text-2xl font-extrabold">No listening sentences yet</h2>
        <p className="my-3 text-body">
          This lesson does not contain stable shadowing, example, mining, or context sentences.
        </p>
        <button type="button" onClick={onExit} className="font-bold text-primary">
          Back to lesson
        </button>
      </section>
    );
  }

  if (!data.session || data.session.status === "cancelled") {
    return (
      <Launcher
        title="Immersion Listening Loop"
        detail={`${data.items.length} practice sentences · transcript hidden first`}
        label="Start Listening Practice"
        disabled={busy}
        start={() => void command("start")}
        back={onExit}
        error={error}
      />
    );
  }

  const sessionData = { ...data, session: data.session };
  if (sessionData.session.status === "completed") {
    return (
      <CompletedListening
        data={sessionData}
        busy={busy}
        error={error}
        practiceAgain={() => void command("practice_again")}
        back={onExit}
      />
    );
  }

  return (
    <ActiveListeningSession
      key={sessionData.session.id}
      data={sessionData}
      busy={busy}
      error={error}
      command={command}
      onExit={onExit}
      onOpenSpeaking={onOpenSpeaking}
      setError={setError}
    />
  );
}

function ActiveListeningSession({
  data,
  busy,
  error,
  command,
  onExit,
  onOpenSpeaking,
  setError,
}: {
  data: ListeningData & { session: ListeningSessionData };
  busy: boolean;
  error: string;
  command: Command;
  onExit: () => void;
  onOpenSpeaking: () => void;
  setError: (value: string) => void;
}) {
  const session = data.session;
  const [firstNote, setFirstNote] = useState(session.firstListenNote);
  const [firstRating, setFirstRating] = useState<ComprehensionLevel | null>(
    session.firstListenComprehension,
  );
  const [secondRating, setSecondRating] = useState<ComprehensionLevel | null>(
    session.secondListenComprehension,
  );
  const [finalRating, setFinalRating] = useState<FinalRelistenRating | null>(
    session.finalRelistenRating,
  );
  const [finalNote, setFinalNote] = useState(session.finalNote);
  const [rate, setRate] = useState(0.86);
  const playback = useListeningPlayback(data.lessonId, (itemId, repetitions) => {
    void command(
      repetitions === 1 ? "record_listen" : "record_loop",
      repetitions === 1 ? { itemId } : { itemId, count: repetitions },
      true,
    );
  });
  const activeStep = stepOrder.indexOf(session.currentStep);
  const reviewItems = selectSourceDiverseListeningItems(
    [...data.items].sort(
      (left, right) =>
        Number(session.revealedItemIds.includes(right.id)) -
          Number(session.revealedItemIds.includes(left.id)) ||
        Number(right.progress.difficult) - Number(left.progress.difficult) ||
        left.id.localeCompare(right.id),
    ),
    8,
  );
  const reviewAudioKey = reviewItems.map((item) => item.id).join("|");

  useEffect(() => {
    if (session.currentStep === "sentence_review") {
      playback.preload(reviewItems, rate);
    }
    // The stable key prevents progress-only response updates from enqueueing the same batch again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback.preload, rate, reviewAudioKey, session.currentStep]);

  async function practiceSpeaking(item: ListeningItemData) {
    setError("");
    try {
      const response = await fetch("/api/speaking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "practice_item",
          lessonId: data.lessonId,
          sourceType: item.sourceType,
          sourceItemId: item.sourceItemId,
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not open Speaking Ladder.");
      playback.stop(true);
      onOpenSpeaking();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not open Speaking Ladder.");
    }
  }

  return (
    <section className="mx-auto max-w-4xl rounded-3xl border-2 border-border bg-card p-5 sm:p-8">
      <header className="mb-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-bold text-muted">{data.lessonTitle}</p>
            <h2 className="mt-1 text-3xl font-extrabold text-heading">
              {stepLabel[session.currentStep]}
            </h2>
          </div>
          <button
            type="button"
            onClick={() => {
              playback.stop(true);
              onExit();
            }}
            className="font-bold text-muted underline"
          >
            Exit and continue later
          </button>
        </div>
        <ol aria-label="Listening practice progress" className="mt-5 grid grid-cols-5 gap-1">
          {stepOrder.map((step, index) => (
            <li key={step} className="min-w-0 text-center">
              <span
                className={`mx-auto block h-2 rounded-full ${
                  index <= activeStep ? "bg-primary" : "bg-border"
                }`}
              />
              <span className="mt-1 hidden text-[11px] font-bold text-muted sm:block">
                {stepLabel[step]}
              </span>
            </li>
          ))}
        </ol>
      </header>

      {session.currentStep === "first_listen" ? (
        <div className="space-y-6">
          <HiddenTranscriptNotice />
          <PracticeTrack track={data.track} rate={rate} setRate={setRate} playback={playback} />
          <div>
            <label htmlFor="first-listen-note" className="font-extrabold text-heading">
              What did you understand?
            </label>
            <p className="mt-1 text-sm text-muted">
              A short note is enough. Grammar does not matter here.
            </p>
            <textarea
              id="first-listen-note"
              value={firstNote}
              maxLength={1000}
              rows={4}
              onChange={(event) => setFirstNote(event.target.value)}
              className="mt-2 w-full rounded-xl border-2 border-border bg-background p-3 focus:border-primary focus:outline-none"
              placeholder="I caught the main topic and a few familiar phrases…"
            />
          </div>
          <ComprehensionPicker value={firstRating} choose={setFirstRating} />
          <PrimaryButton
            disabled={busy || !firstRating}
            onClick={() => {
              playback.stop(true);
              void command("save_first_listen", {
                comprehension: firstRating,
                note: firstNote,
              });
            }}
          >
            Check the meaning
          </PrimaryButton>
        </div>
      ) : null}

      {session.currentStep === "check_meaning" ? (
        <div className="space-y-6">
          <div className="rounded-2xl bg-highlight p-5">
            <p className="text-xs font-extrabold uppercase tracking-wide text-muted">
              Simple Summary
            </p>
            <p className="mt-2 text-lg leading-relaxed text-body">{data.summary}</p>
          </div>
          <UsefulPhrases items={data.items} />
          <SentenceTranscript
            items={data.items}
            revealed={new Set(session.revealedItemIds)}
            playback={playback}
            rate={rate}
            command={command}
          />
          <PrimaryButton
            disabled={busy}
            onClick={() => {
              playback.stop(true);
              void command("advance_step", { nextStep: "second_listen" });
            }}
          >
            Listen again
          </PrimaryButton>
        </div>
      ) : null}

      {session.currentStep === "second_listen" ? (
        <div className="space-y-6">
          <HiddenTranscriptNotice />
          <PracticeTrack track={data.track} rate={rate} setRate={setRate} playback={playback} />
          <ComprehensionPicker value={secondRating} choose={setSecondRating} />
          {session.firstListenComprehension && secondRating ? (
            <p className="rounded-xl bg-highlight p-3 text-center font-bold text-heading">
              Your check-in: {comprehensionLabel[session.firstListenComprehension]} →{" "}
              {comprehensionLabel[secondRating]}
            </p>
          ) : null}
          <PrimaryButton
            disabled={busy || !secondRating}
            onClick={() => {
              playback.stop(true);
              void command("save_second_listen", { comprehension: secondRating });
            }}
          >
            Review the sentences
          </PrimaryButton>
        </div>
      ) : null}

      {session.currentStep === "sentence_review" ? (
        <div className="space-y-6">
          <div>
            <h3 className="text-xl font-extrabold text-heading">Audio First review</h3>
            <p className="mt-1 text-body">
              Listen before revealing. Loop a sentence, then decide what you can hear now.
            </p>
          </div>
          <div className="space-y-4">
            {reviewItems.map((item) => (
              <AudioFirstCard
                key={item.id}
                item={item}
                revealed={session.revealedItemIds.includes(item.id)}
                rate={rate}
                playback={playback}
                command={command}
                practiceSpeaking={() => void practiceSpeaking(item)}
              />
            ))}
          </div>
          <PrimaryButton
            disabled={busy}
            onClick={() => {
              playback.stop(true);
              void command("advance_step", { nextStep: "final_relisten" });
            }}
          >
            Go to final re-listen
          </PrimaryButton>
        </div>
      ) : null}

      {session.currentStep === "final_relisten" ? (
        <div className="space-y-6">
          <HiddenTranscriptNotice />
          <ul className="rounded-2xl bg-highlight p-5 text-body">
            <li>Follow the main idea.</li>
            <li>Notice familiar phrases.</li>
            <li>Do not translate every word.</li>
          </ul>
          <PracticeTrack track={data.track} rate={rate} setRate={setRate} playback={playback} />
          <fieldset>
            <legend className="font-extrabold text-heading">How did the final listen feel?</legend>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              {[
                ["easier", "Easier than before"],
                ["same", "About the same"],
                ["still_difficult", "Still difficult"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={finalRating === value}
                  onClick={() => setFinalRating(value as FinalRelistenRating)}
                  className={`rounded-xl border-2 p-3 text-left font-bold ${
                    finalRating === value
                      ? "border-primary bg-highlight text-primary"
                      : "border-border text-body"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </fieldset>
          <div>
            <label htmlFor="final-listen-note" className="font-extrabold text-heading">
              Final note (optional)
            </label>
            <textarea
              id="final-listen-note"
              value={finalNote}
              maxLength={1000}
              rows={3}
              onChange={(event) => setFinalNote(event.target.value)}
              className="mt-2 w-full rounded-xl border-2 border-border bg-background p-3 focus:border-primary focus:outline-none"
            />
          </div>
          <PrimaryButton
            disabled={busy || !finalRating}
            onClick={() => {
              playback.stop(true);
              void command("complete", { rating: finalRating, note: finalNote });
            }}
          >
            Complete listening session
          </PrimaryButton>
        </div>
      ) : null}

      {playback.state.error ? (
        <p role="alert" className="mt-5 text-center text-sm font-bold text-wrong">
          {playback.state.error}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-5 text-center text-sm font-bold text-wrong">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function PracticeTrack({
  track,
  rate,
  setRate,
  playback,
}: {
  track: string;
  rate: number;
  setRate: (value: number) => void;
  playback: ReturnType<typeof useListeningPlayback>;
}) {
  const active = playback.state.itemId === "track";
  return (
    <div className="rounded-2xl border-2 border-border p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-extrabold text-heading">Kokoro practice audio</p>
          <p className="text-sm text-muted">
            Generated from this lesson’s saved transcript or practice sentences.
          </p>
        </div>
        <label className="text-sm font-bold text-heading">
          Speed{" "}
          <select
            value={rate}
            onChange={(event) => setRate(Number(event.target.value))}
            className="rounded-lg border border-border bg-background px-2 py-1"
          >
            <option value={0.72}>Slow</option>
            <option value={0.86}>Normal</option>
            <option value={1}>Fast</option>
          </select>
        </label>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!track || playback.state.loading}
          onClick={() => void playback.play("track", track, 1, rate)}
          className="rounded-full bg-primary px-5 py-2 font-bold text-white disabled:opacity-40"
        >
          {active && playback.state.loading ? "Preparing…" : "Play"}
        </button>
        {active && (playback.state.playing || playback.state.paused) ? (
          <button
            type="button"
            onClick={playback.togglePause}
            className="rounded-full border-2 border-primary px-4 py-2 font-bold text-primary"
          >
            {playback.state.paused ? "Continue" : "Pause"}
          </button>
        ) : null}
        <button
          type="button"
          disabled={!track}
          onClick={() => void playback.play("track", track, 1, rate)}
          className="rounded-full border-2 border-border px-4 py-2 font-bold"
        >
          Replay
        </button>
        {active && playback.state.source ? (
          <span role="status" className="self-center text-xs text-muted">
            {playback.state.source === "kokoro" ? "Kokoro local" : "Browser voice fallback"}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function HiddenTranscriptNotice() {
  return (
    <div className="rounded-2xl border-2 border-dashed border-border p-5 text-center">
      <p className="font-extrabold text-heading">Transcript hidden</p>
      <p className="mt-1 text-sm text-muted">Listen for meaning without reading first.</p>
    </div>
  );
}

function ComprehensionPicker({
  value,
  choose,
}: {
  value: ComprehensionLevel | null;
  choose: (value: ComprehensionLevel) => void;
}) {
  return (
    <fieldset>
      <legend className="font-extrabold text-heading">How much did you understand?</legend>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {comprehensionOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => choose(option.value)}
            className={`rounded-xl border-2 p-3 text-left ${
              value === option.value
                ? "border-primary bg-highlight text-primary"
                : "border-border text-body"
            }`}
          >
            <strong className="block">{option.label}</strong>
            <span className="text-xs">{option.detail}</span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function UsefulPhrases({ items }: { items: ListeningItemData[] }) {
  const phrases = [
    ...new Set(items.flatMap((item) => (item.targetPhrase ? [item.targetPhrase] : []))),
  ].slice(0, 5);
  if (!phrases.length) return null;
  return (
    <div>
      <h3 className="font-extrabold text-heading">Useful phrases already in this lesson</h3>
      <ul className="mt-2 flex flex-wrap gap-2">
        {phrases.map((phrase) => (
          <li key={phrase} className="rounded-full bg-highlight px-3 py-1 text-sm font-bold">
            {phrase}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SentenceTranscript({
  items,
  revealed,
  playback,
  rate,
  command,
}: {
  items: ListeningItemData[];
  revealed: Set<string>;
  playback: ReturnType<typeof useListeningPlayback>;
  rate: number;
  command: Command;
}) {
  const visibleItems = items.slice(0, 8);
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-extrabold text-heading">Practice transcript</h3>
          <p className="text-sm text-muted">Reveal only the sentences you need.</p>
        </div>
        <button
          type="button"
          onClick={() => {
            if (window.confirm("Reveal every practice sentence in this session?"))
              void command("reveal_all");
          }}
          className="font-bold text-primary underline"
        >
          Reveal all
        </button>
      </div>
      <ol className="mt-3 space-y-2">
        {visibleItems.map((item, index) => {
          const isRevealed = revealed.has(item.id);
          return (
            <li key={item.id} className="rounded-xl border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-bold text-muted">Sentence {index + 1}</span>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void playback.play(item.id, item.text, 1, rate)}
                    className="font-bold text-primary underline"
                  >
                    Listen
                  </button>
                  {!isRevealed ? (
                    <button
                      type="button"
                      onClick={() => void command("reveal_item", { itemId: item.id })}
                      className="font-bold text-primary underline"
                    >
                      Reveal sentence
                    </button>
                  ) : null}
                </div>
              </div>
              <p className={`mt-2 text-lg font-bold ${isRevealed ? "" : "select-none blur-sm"}`}>
                {isRevealed ? item.text : "This sentence stays hidden until you reveal it."}
              </p>
              {isRevealed ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void command("mark_recognized", { itemId: item.id })}
                    className="rounded-full border border-primary px-3 py-1 text-sm font-bold text-primary"
                  >
                    I could hear it
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void command("mark_understood_after_reading", { itemId: item.id })
                    }
                    className="rounded-full border border-primary px-3 py-1 text-sm font-bold text-primary"
                  >
                    I understood it after reading
                  </button>
                  <button
                    type="button"
                    onClick={() => void command("mark_difficult", { itemId: item.id })}
                    className="rounded-full border border-border px-3 py-1 text-sm font-bold"
                  >
                    Still difficult
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function AudioFirstCard({
  item,
  revealed,
  rate,
  playback,
  command,
  practiceSpeaking,
}: {
  item: ListeningItemData;
  revealed: boolean;
  rate: number;
  playback: ReturnType<typeof useListeningPlayback>;
  command: Command;
  practiceSpeaking: () => void;
}) {
  const active = playback.state.itemId === item.id;
  const audio = playback.audioStatus(item.id);
  const recognized = item.progress.recognitionStatus === "recognized";
  const difficult = item.progress.difficult;
  const [savingAction, setSavingAction] = useState<"mark_recognized" | "mark_difficult" | null>(
    null,
  );
  const [failedAction, setFailedAction] = useState<"mark_recognized" | "mark_difficult" | null>(
    null,
  );

  async function saveAction(action: "mark_recognized" | "mark_difficult") {
    setSavingAction(action);
    setFailedAction(null);
    const result = await command(action, { itemId: item.id }, true);
    if (!result) setFailedAction(action);
    setSavingAction(null);
  }

  const audioLabel =
    audio.status === "ready"
      ? "Kokoro audio ready"
      : audio.status === "browser"
        ? "Using browser voice"
        : audio.status === "failed"
          ? "Audio failed"
          : "Preparing Kokoro audio...";
  return (
    <article className="rounded-2xl border-2 border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-extrabold text-muted">Audio first</p>
        <span className="text-xs text-muted">
          Heard {item.progress.listenCount} · looped {item.progress.loopCount}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-bold text-muted">
        <span role="status">{audioLabel}</span>
        {audio.status === "browser" || audio.status === "failed" ? (
          <button
            type="button"
            disabled={active && playback.state.loading}
            onClick={() => void playback.retryKokoro(item.id, item.text, rate)}
            className="text-primary underline disabled:cursor-wait disabled:opacity-50"
          >
            {active && playback.state.loading ? "Retrying Kokoro..." : "Retry Kokoro"}
          </button>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void playback.play(item.id, item.text, 1, rate)}
          className="rounded-full bg-primary px-4 py-2 text-sm font-bold text-white"
        >
          Play once
        </button>
        <button
          type="button"
          onClick={() => void playback.play(item.id, item.text, 3, rate)}
          className="rounded-full border-2 border-primary px-4 py-2 text-sm font-bold text-primary"
        >
          Loop 3
        </button>
        <button
          type="button"
          onClick={() => void playback.play(item.id, item.text, 5, rate)}
          className="rounded-full border-2 border-primary px-4 py-2 text-sm font-bold text-primary"
        >
          Loop 5
        </button>
        {active && (playback.state.playing || playback.state.paused) ? (
          <>
            <button
              type="button"
              onClick={playback.togglePause}
              className="rounded-full border-2 border-border px-4 py-2 text-sm font-bold"
            >
              {playback.state.paused ? "Continue" : "Pause"}
            </button>
            <button
              type="button"
              onClick={() => playback.stop(true)}
              className="rounded-full border-2 border-border px-4 py-2 text-sm font-bold"
            >
              Stop loop
            </button>
          </>
        ) : null}
      </div>
      {active && playback.state.target > 1 ? (
        <p role="status" className="mt-2 text-sm font-bold text-muted">
          {playback.state.loading
            ? "Preparing audio…"
            : `Listened ${playback.state.completed} of ${playback.state.target}`}
        </p>
      ) : null}
      {!revealed ? (
        <button
          type="button"
          onClick={() => void command("reveal_item", { itemId: item.id })}
          className="mt-4 font-bold text-primary underline"
        >
          Reveal transcript
        </button>
      ) : (
        <div className="mt-4 rounded-xl bg-highlight p-4">
          <p className="text-lg font-extrabold text-heading">{item.text}</p>
          {item.targetPhrase ? (
            <p className="mt-2 text-sm">
              <strong>Target phrase:</strong> {item.targetPhrase}
            </p>
          ) : null}
          {item.meaning ? (
            <p className="mt-1 text-sm">
              <strong>Meaning:</strong> {item.meaning}
            </p>
          ) : null}
          {item.sourceContext ? (
            <p className="mt-1 text-sm text-muted">{item.sourceContext}</p>
          ) : null}
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          aria-pressed={recognized}
          disabled={savingAction !== null || recognized}
          onClick={() => void saveAction("mark_recognized")}
          className={`rounded-full border-2 border-primary px-3 py-2 text-sm font-bold text-primary disabled:cursor-wait ${
            recognized ? "bg-highlight" : ""
          }`}
        >
          {savingAction === "mark_recognized"
            ? "Saving..."
            : recognized
              ? "Heard clearly (selected)"
              : "I can hear it now"}
        </button>
        {revealed ? (
          <button
            type="button"
            onClick={() => void command("mark_understood_after_reading", { itemId: item.id })}
            className="rounded-full border-2 border-primary px-3 py-2 text-sm font-bold text-primary"
          >
            I understand it after reading
          </button>
        ) : null}
        <button
          type="button"
          aria-pressed={difficult}
          disabled={savingAction !== null || difficult}
          onClick={() => void saveAction("mark_difficult")}
          className={`rounded-full border-2 px-3 py-2 text-sm font-bold disabled:cursor-wait ${
            difficult ? "border-primary bg-highlight text-primary" : "border-border"
          }`}
        >
          {savingAction === "mark_difficult"
            ? "Saving..."
            : difficult
              ? "Marked difficult (selected)"
              : "Still difficult"}
        </button>
        {revealed && item.speakingPracticeItemId ? (
          <button
            type="button"
            onClick={practiceSpeaking}
            className="rounded-full bg-heading px-4 py-2 text-sm font-bold text-white"
          >
            Practice this sentence
          </button>
        ) : null}
      </div>
      {failedAction ? (
        <p role="alert" className="mt-3 text-sm font-bold text-wrong">
          Progress was not saved.{" "}
          <button
            type="button"
            disabled={savingAction !== null}
            onClick={() => void saveAction(failedAction)}
            className="underline disabled:opacity-50"
          >
            Retry
          </button>
        </p>
      ) : null}
    </article>
  );
}

function CompletedListening({
  data,
  busy,
  error,
  practiceAgain,
  back,
}: {
  data: ListeningData & { session: ListeningSessionData };
  busy: boolean;
  error: string;
  practiceAgain: () => void;
  back: () => void;
}) {
  const playback = useListeningPlayback(data.lessonId, () => undefined);
  const difficult = data.items.filter((item) => item.progress.difficult).length;
  return (
    <section className="mx-auto max-w-3xl rounded-3xl border-2 border-border bg-card p-8 text-center">
      <h2 className="text-3xl font-extrabold text-heading">Listening session complete</h2>
      <p className="mt-2 text-body">Your listening progress is saved separately from speaking.</p>
      <div className="mx-auto mt-6 grid max-w-xl gap-3 sm:grid-cols-3">
        <Stat
          label="First listen"
          value={
            data.session.firstListenComprehension
              ? comprehensionLabel[data.session.firstListenComprehension]
              : "—"
          }
        />
        <Stat
          label="Second listen"
          value={
            data.session.secondListenComprehension
              ? comprehensionLabel[data.session.secondListenComprehension]
              : "—"
          }
        />
        <Stat label="Difficult sentences" value={difficult} />
      </div>
      <div className="mx-auto mt-6 max-w-xl text-left">
        <PracticeTrack
          track={data.track}
          rate={0.86}
          setRate={() => undefined}
          playback={playback}
        />
      </div>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            playback.stop(false);
            practiceAgain();
          }}
          className="rounded-full bg-primary px-6 py-3 font-bold text-white disabled:opacity-40"
        >
          Practice Again
        </button>
        <button
          type="button"
          onClick={() => {
            playback.stop(false);
            back();
          }}
          className="px-4 py-2 font-bold text-muted"
        >
          Back to lesson
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-4 font-bold text-wrong">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function PrimaryButton({
  disabled,
  onClick,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="w-full rounded-xl bg-primary px-5 py-3 font-extrabold text-white disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function Launcher({
  title,
  detail,
  label,
  disabled,
  start,
  back,
  error,
}: {
  title: string;
  detail: string;
  label: string;
  disabled: boolean;
  start: () => void;
  back: () => void;
  error: string;
}) {
  return (
    <section className="rounded-3xl border-2 border-border bg-card p-8 text-center">
      <h2 className="text-2xl font-extrabold">{title}</h2>
      <p className="my-4 text-body">{detail}</p>
      <button
        type="button"
        disabled={disabled}
        onClick={start}
        className="rounded-full bg-primary px-6 py-3 font-bold text-white disabled:opacity-40"
      >
        {label}
      </button>
      <button type="button" onClick={back} className="ml-3 font-bold text-primary">
        Back
      </button>
      {error ? (
        <p role="alert" className="mt-4 font-bold text-wrong">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-border p-3">
      <strong className="block text-xl text-heading">{value}</strong>
      <span className="text-sm text-muted">{label}</span>
    </div>
  );
}
