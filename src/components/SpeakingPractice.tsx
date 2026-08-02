"use client";

import { useEffect, useRef, useState } from "react";

import SpeakButton from "@/components/lesson/SpeakButton";
import { audioClient } from "@/lib/audio-client";
import { AUDIO_DEFAULTS, rateToKokoroSpeed } from "@/lib/audio-domain";
import type { LadderStep, PracticeTask } from "@/lib/speaking-practice";

type Summary = {
  practiced: number;
  recalledWithoutHelp: number;
  neededAnswer: number;
  personalized: number;
  freeSpeak: number;
  hard: number;
  okay: number;
  easy: number;
  reviewIds: string[];
};

type CheckResult = {
  understandable: boolean;
  verdict: "clear" | "needs_small_fix" | "needs_rewrite" | "unclear";
  correctedSentence: string;
  naturalAlternative: string | null;
  explanationVi: string;
  inputHash: string;
  inputText: string;
  checkedAt: string;
};

type Session = {
  id: string;
  lessonId: string;
  currentItemIndex: number;
  currentStep: LadderStep;
  revision: number;
  status: "active" | "completed" | "cancelled";
  drafts: Record<string, string>;
  draftVersions: Record<string, number>;
  checks: Record<string, CheckResult>;
  checkVersions: Record<string, number>;
  revealedItemIds: string[];
};

type Data = {
  session: Session | null;
  lessonTitle: string;
  tasks: PracticeTask[];
  empty?: boolean;
  summary?: Summary;
};

const stepLabel: Record<LadderStep, string> = {
  read: "Read",
  recall: "Recall",
  keywords: "Keywords",
  personalize: "Personalize",
  free_speak: "Free Speak",
};

function normalized(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

async function readResponse(response: Response) {
  const body = (await response.json()) as Data & { error?: string; code?: string };
  if (!response.ok) {
    const error = new Error(body.error ?? "Could not save speaking progress.") as Error & {
      status?: number;
      code?: string;
    };
    error.status = response.status;
    error.code = body.code;
    throw error;
  }
  return body;
}

export default function SpeakingPractice({
  lessonId,
  onExit,
}: {
  lessonId: string;
  onExit: () => void;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [said, setSaid] = useState(false);
  const [draft, setDraft] = useState("");
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [commandBusy, setCommandBusy] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const mountedRef = useRef(true);
  const autosaveAbortRef = useRef<AbortController | null>(null);
  const draftVersionRef = useRef(0);
  const checkVersionRef = useRef(0);
  const savedDraftRef = useRef("");
  const checkRequestRef = useRef(0);

  async function loadStatus(message?: string) {
    const response = await fetch("/api/speaking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "status", lessonId }),
    });
    const latest = await readResponse(response);
    if (mountedRef.current) {
      setData(latest);
      if (message) setError(message);
    }
    return latest;
  }

  useEffect(() => {
    mountedRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadStatus().catch((reason: unknown) => {
      if (mountedRef.current) {
        setError(reason instanceof Error ? reason.message : "Could not load speaking practice.");
      }
    });
    return () => {
      mountedRef.current = false;
      autosaveAbortRef.current?.abort();
      checkRequestRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lessonId]);

  const index = data?.session?.currentItemIndex ?? 0;
  const task = data?.tasks[index];
  const session = data?.session;

  useEffect(() => {
    const persistedDraft = (task && session?.drafts?.[task.id]) || "";
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(persistedDraft);
    savedDraftRef.current = normalized(persistedDraft);
    draftVersionRef.current = (task && session?.draftVersions?.[task.id]) ?? 0;
    checkVersionRef.current = (task && session?.checkVersions?.[task.id]) ?? 0;
    setCheck((task && session?.checks?.[task.id]) || null);
    setSaid(false);
    setSaveStatus("idle");
    autosaveAbortRef.current?.abort();
    checkRequestRef.current += 1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, session?.id]);

  function bindingFor(snapshot: Data) {
    const active = snapshot.session;
    const activeTask = active && snapshot.tasks[active.currentItemIndex];
    if (!active || !activeTask) throw new Error("Speaking item is unavailable.");
    return {
      sessionId: active.id,
      practiceItemId: activeTask.id,
      expectedItemIndex: active.currentItemIndex,
      expectedStep: active.currentStep,
      expectedRevision: active.revision,
    };
  }

  async function postCommand(action: string, extra: Record<string, unknown>, snapshot?: Data) {
    const body: Record<string, unknown> = { action, lessonId, ...extra };
    if (snapshot?.session && !["start", "start_new", "review", "practice_item"].includes(action)) {
      Object.assign(body, bindingFor(snapshot));
    }
    const response = await fetch("/api/speaking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return readResponse(response);
  }

  async function saveDraftNow(snapshot: Data, value: string, signal?: AbortSignal) {
    const active = snapshot.session;
    const activeTask = active && snapshot.tasks[active.currentItemIndex];
    if (!active || !activeTask || active.currentStep !== "personalize") return snapshot;
    const cleanDraft = normalized(value.slice(0, 500));
    if (cleanDraft === savedDraftRef.current) return snapshot;
    const clientDraftVersion = Math.max(
      draftVersionRef.current + 1,
      (active.draftVersions?.[activeTask.id] ?? 0) + 1,
    );
    setSaveStatus("saving");
    const response = await fetch("/api/speaking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        action: "save_draft",
        lessonId,
        ...bindingFor(snapshot),
        draft: value.slice(0, 500),
        clientDraftVersion,
      }),
    });
    const next = await readResponse(response);
    draftVersionRef.current = clientDraftVersion;
    savedDraftRef.current = cleanDraft;
    if (mountedRef.current) {
      setData(next);
      setSaveStatus("saved");
    }
    return next;
  }

  useEffect(() => {
    if (
      !data?.session ||
      data.session.status !== "active" ||
      data.session.currentStep !== "personalize" ||
      !task ||
      normalized(draft) === savedDraftRef.current
    )
      return;
    const snapshot = data;
    const controller = new AbortController();
    autosaveAbortRef.current?.abort();
    autosaveAbortRef.current = controller;
    const timer = window.setTimeout(() => {
      void saveDraftNow(snapshot, draft, controller.signal).catch((reason: unknown) => {
        if (controller.signal.aborted || !mountedRef.current) return;
        setSaveStatus("error");
        if ((reason as { status?: number }).status === 409) {
          void loadStatus("Speaking practice changed in another request. Latest state loaded.");
        }
      });
    }, 500);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // Revision changes after a successful save must not schedule another save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, task?.id, session?.id, session?.currentItemIndex, session?.currentStep]);

  useEffect(() => {
    if (!session || session.status !== "active") return;
    const items = (data?.tasks ?? []).slice(index, index + 2).map((candidate, offset) => ({
      text: candidate.text,
      priority: 2 + offset,
      lessonId,
      itemId: candidate.sourceItemId,
      sourceType:
        candidate.sourceType === "sentence_mining"
          ? ("sentence-mining" as const)
          : candidate.sourceType,
      config: {
        ...AUDIO_DEFAULTS,
        speed: rateToKokoroSpeed(candidate.sourceType === "shadowing" ? 0.78 : 0.82),
      },
    }));
    audioClient.preload(items);
    return () => audioClient.cancelLesson(lessonId);
  }, [data?.tasks, index, lessonId, session]);

  async function command(action: string, extra: Record<string, unknown> = {}) {
    if (commandBusy) return;
    setCommandBusy(action);
    setError("");
    try {
      let snapshot = data ?? undefined;
      if (
        snapshot?.session?.currentStep === "personalize" &&
        ["advance", "complete_item"].includes(action)
      ) {
        autosaveAbortRef.current?.abort();
        snapshot = await saveDraftNow(snapshot, draft);
      }
      const next = await postCommand(action, extra, snapshot);
      if (mountedRef.current) {
        setData(next);
        if (action === "complete_item") {
          setSaid(false);
          setDraft("");
        }
      }
    } catch (reason) {
      const commandError = reason as Error & { status?: number };
      if (commandError.status === 409) {
        await loadStatus("Speaking practice changed in another request. Latest state loaded.");
      } else if (mountedRef.current) {
        setError(commandError.message || "Could not save speaking progress.");
      }
    } finally {
      if (mountedRef.current) setCommandBusy(null);
    }
  }

  async function checkSentence() {
    if (!data || !task || checking) return;
    setChecking(true);
    setError("");
    const requestId = ++checkRequestRef.current;
    try {
      autosaveAbortRef.current?.abort();
      const snapshot = await saveDraftNow(data, draft);
      const checkedItemId = snapshot.tasks[snapshot.session!.currentItemIndex].id;
      const checkedInput = normalized(draft);
      const clientCheckVersion = Math.max(
        checkVersionRef.current + 1,
        (snapshot.session?.checkVersions?.[checkedItemId] ?? 0) + 1,
      );
      const response = await fetch("/api/speaking/check-sentence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lessonId,
          ...bindingFor(snapshot),
          sentence: draft,
          clientCheckVersion,
        }),
      });
      const body = (await response.json()) as {
        result?: CheckResult;
        state?: Data;
        error?: string;
        code?: string;
      };
      if (!response.ok) {
        const checkError = new Error(body.error ?? "Could not check your sentence.") as Error & {
          status?: number;
        };
        checkError.status = response.status;
        throw checkError;
      }
      if (
        mountedRef.current &&
        requestId === checkRequestRef.current &&
        task.id === checkedItemId &&
        normalized(draft) === checkedInput &&
        body.result &&
        body.state
      ) {
        setData(body.state);
        setCheck(body.result);
        checkVersionRef.current = clientCheckVersion;
      }
    } catch (reason) {
      const checkError = reason as Error & { status?: number };
      if (checkError.status === 409) {
        await loadStatus("That sentence check was stale, so it was not saved.");
      } else if (mountedRef.current && requestId === checkRequestRef.current) {
        setError(checkError.message || "Could not check your sentence.");
      }
    } finally {
      if (mountedRef.current && requestId === checkRequestRef.current) setChecking(false);
    }
  }

  if (!data)
    return (
      <p role="status" className="p-8 text-center font-bold text-muted">
        Loading speaking practice…
      </p>
    );
  if (data.empty || !data.tasks.length)
    return (
      <section className="p-8 text-center">
        <h2 className="text-2xl font-bold">No speaking sentences yet</h2>
        <p className="my-3">This lesson does not contain enough standalone English sentences.</p>
        <button className="font-bold text-primary" onClick={onExit}>
          Back to lesson
        </button>
      </section>
    );
  if (!data.session || data.session.status === "cancelled")
    return (
      <Launcher
        label={data.session ? "Start New Speaking Practice" : "Start Speaking Practice"}
        detail={`${data.tasks.length} sentences · about 5–10 minutes`}
        start={() => void command(data.session ? "start_new" : "start")}
        back={onExit}
        busy={Boolean(commandBusy)}
      />
    );
  if (data.session.status === "completed") {
    const summary = data.summary!;
    const review = data.tasks
      .filter((candidate) => summary.reviewIds.includes(candidate.id))
      .slice(0, 4);
    return (
      <section
        className="rounded-3xl border-2 border-border bg-card p-8"
        aria-busy={Boolean(commandBusy)}
      >
        <h2 className="text-center text-3xl font-extrabold">Session complete</h2>
        <p className="my-3 text-center">You practiced speaking without relying on a full script.</p>
        <div className="mx-auto grid max-w-xl grid-cols-2 gap-3 py-5 text-sm sm:grid-cols-3">
          <Stat label="Practiced" value={summary.practiced} />
          <Stat label="Without help" value={summary.recalledWithoutHelp} />
          <Stat label="Showed answer" value={summary.neededAnswer} />
          <Stat label="Personalized" value={summary.personalized} />
          <Stat label="Free Speak" value={summary.freeSpeak} />
          <Stat
            label="Hard / Okay / Easy"
            value={`${summary.hard} / ${summary.okay} / ${summary.easy}`}
          />
        </div>
        {review.length > 0 && (
          <div className="mx-auto max-w-xl rounded-2xl bg-highlight p-4">
            <p className="font-extrabold">Review next</p>
            <ul className="mt-2 list-disc pl-5 text-sm">
              {review.map((candidate) => (
                <li key={candidate.id}>{candidate.targetPhrase || candidate.text}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          {review.length > 0 && (
            <button
              disabled={Boolean(commandBusy)}
              className="rounded-full border-2 border-primary px-4 py-2 font-bold text-primary disabled:opacity-40"
              onClick={() => void command("review")}
            >
              Review Difficult Items
            </button>
          )}
          <button
            disabled={Boolean(commandBusy)}
            className="rounded-full bg-primary px-5 py-3 font-bold text-white disabled:opacity-40"
            onClick={() => void command("start_new")}
          >
            {commandBusy === "start_new" ? "Starting…" : "Practice Again"}
          </button>
          <button className="px-4 py-2 font-bold text-muted" onClick={onExit}>
            Back to Lesson
          </button>
        </div>
        {error && (
          <p role="alert" className="mt-4 text-center text-wrong">
            {error}
          </p>
        )}
      </section>
    );
  }
  if (!task)
    return (
      <p role="alert" className="p-8 text-center">
        Speaking item is unavailable.
      </p>
    );

  const activeSession = data.session;
  const step = activeSession.currentStep;
  const activeSteps = task.steps;
  const next = activeSteps[activeSteps.indexOf(step) + 1];
  const stepNumber = activeSteps.indexOf(step) + 1;
  const helped = activeSession.revealedItemIds.includes(task.id);
  const busy = Boolean(commandBusy);
  const instruction: Partial<Record<LadderStep, string>> = {
    read: "Read the sentence aloud.",
    recall: "Say the complete sentence aloud before showing the answer.",
    keywords:
      "Say the idea again using only these keywords. You do not need to use the exact original words.",
    free_speak: "Explain why this matters to you or give a real example.",
  };
  const advanceLabel: Partial<Record<LadderStep, string>> = {
    read: "I read it aloud",
    recall: "I said it",
    keywords: "I said it",
    free_speak: "I added one more sentence",
  };

  function saveDraft(value: string) {
    setDraft(value.slice(0, 500));
    setSaveStatus("idle");
  }

  return (
    <section
      className="mx-auto max-w-3xl rounded-3xl border-2 border-border bg-card p-6 sm:p-10"
      aria-busy={busy || checking}
    >
      <div className="mb-8 flex flex-wrap justify-between gap-2 text-sm font-bold text-muted">
        <span>{data.lessonTitle}</span>
        <span className="text-right">
          <span className="block">
            Sentence {index + 1} of {data.tasks.length}
          </span>
          <span className="block">
            Step {stepNumber} of {activeSteps.length} · {stepLabel[step]}
          </span>
        </span>
      </div>
      {step === "personalize" ? (
        <div className="space-y-4">
          <h2 className="text-center text-3xl font-extrabold text-heading">Make it about you</h2>
          <p className="text-center text-body">
            Keep the useful pattern, but change the details.
            <br />
            <strong>Say your new sentence aloud.</strong>
          </p>
          <div className="rounded-2xl border border-border p-4">
            <p className="text-xs font-extrabold uppercase text-muted">Original</p>
            <p className="mt-1 text-xl font-bold">{task.text}</p>
          </div>
          {task.personalizationQuestion && (
            <div>
              <p className="text-xs font-extrabold uppercase text-muted">Question</p>
              <p className="mt-1 text-lg font-bold">{task.personalizationQuestion}</p>
            </div>
          )}
          <div className="rounded-2xl bg-highlight p-4">
            <p className="text-xs font-extrabold uppercase text-muted">
              {task.personalization.startsWith("Say the same") ? "Try this" : "Useful pattern"}
            </p>
            <p className="mt-1 text-xl font-bold">{task.personalization}</p>
          </div>
          <p className="text-center text-sm text-muted">
            Ideas: work · English · gaming · recording videos · daily habits
          </p>
          <div>
            <label
              htmlFor="personal-sentence"
              className="block text-sm font-extrabold text-heading"
            >
              Your sentence
            </label>
            <textarea
              id="personal-sentence"
              value={draft}
              maxLength={500}
              onChange={(event) => saveDraft(event.target.value)}
              placeholder="Write a sentence that is true for you..."
              rows={3}
              className="mt-2 w-full rounded-xl border-2 border-border bg-background p-3 text-body focus:border-primary focus:outline-none"
            />
            <div className="mt-2 flex items-start justify-between gap-3">
              <p className="text-xs text-muted">
                Writing is optional. The main goal is to say the sentence aloud.
                <span className="ml-2" role="status">
                  {saveStatus === "saving"
                    ? "Saving…"
                    : saveStatus === "saved"
                      ? "Saved"
                      : saveStatus === "error"
                        ? "Not saved"
                        : ""}
                </span>
              </p>
              <button
                type="button"
                className="text-sm font-bold text-primary underline"
                onClick={() => saveDraft("")}
                disabled={!draft}
              >
                Clear
              </button>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={
                  !draft.trim() || draft.length > 500 || /_{3,}/.test(draft) || checking || busy
                }
                onClick={() => void checkSentence()}
                className="rounded-xl border-2 border-primary px-4 py-2 font-extrabold text-primary disabled:opacity-40"
              >
                {checking ? "Checking your sentence…" : "Check my sentence"}
              </button>
              {check && (
                <button
                  type="button"
                  className="px-3 py-2 font-bold text-muted"
                  onClick={() => setCheck(null)}
                >
                  Dismiss
                </button>
              )}
            </div>
          </div>
          {check && (
            <SentenceFeedback
              result={check}
              stale={normalized(draft) !== check.inputText}
              applySentence={saveDraft}
              checkAgain={() => void checkSentence()}
            />
          )}
          <button
            type="button"
            disabled={busy}
            className="w-full rounded-xl bg-primary px-5 py-3 font-extrabold text-white disabled:opacity-40 focus:outline-2 focus:outline-offset-2"
            onClick={() => setSaid(true)}
          >
            I said my sentence
          </button>
          {said && check && (
            <p className="text-center text-sm font-bold text-muted">
              Rate how easily you could say your final sentence aloud.
            </p>
          )}
        </div>
      ) : (
        <>
          <h2 className="mb-3 min-h-28 text-center text-3xl font-extrabold leading-snug text-heading">
            {step === "read"
              ? task.text
              : step === "recall"
                ? helped
                  ? task.text
                  : task.recallMask
                : step === "keywords"
                  ? task.keywords.join(" · ")
                  : "Add one more sentence in your own words."}
          </h2>
          {instruction[step] && (
            <p className="mx-auto max-w-xl text-center text-body">{instruction[step]}</p>
          )}
          {step === "free_speak" && (
            <p className="mt-3 text-center text-body">
              Prompt words: {task.keywords.slice(0, 4).join(" · ")}
            </p>
          )}
        </>
      )}
      <div className="mt-8 flex min-h-16 flex-wrap items-center justify-center gap-3">
        {step !== "free_speak" && (
          <SpeakButton
            text={task.text}
            lessonId={lessonId}
            itemId={task.sourceItemId}
            sourceType="speaking"
            rate={task.sourceType === "shadowing" ? 0.78 : 0.82}
          />
        )}
        {step === "recall" && !helped && (
          <button
            disabled={busy}
            className="rounded-full border-2 border-border px-4 py-2 font-bold disabled:opacity-40"
            onClick={() => void command("show_answer")}
          >
            {commandBusy === "show_answer" ? "Showing…" : "Show answer"}
          </button>
        )}
        {next ? (
          <button
            disabled={busy}
            className="rounded-full bg-primary px-6 py-3 font-bold text-white disabled:opacity-40"
            onClick={() => void command("advance")}
          >
            {commandBusy === "advance" ? "Saving…" : (advanceLabel[step] ?? "Continue")}
          </button>
        ) : step === "free_speak" && !said ? (
          <button
            disabled={busy}
            className="rounded-full bg-primary px-6 py-3 font-bold text-white disabled:opacity-40"
            onClick={() => setSaid(true)}
          >
            I added one more sentence
          </button>
        ) : step === "personalize" && !said ? null : (
          <Rating
            enabled={
              (!("personalize free_speak".split(" ") as string[]).includes(step) || said) && !busy
            }
            choose={(rating) => void command("complete_item", { rating })}
          />
        )}
        <button className="px-3 py-2 font-bold text-muted" onClick={onExit}>
          Exit and continue later
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-4 text-center text-wrong">
          {error}
        </p>
      )}
    </section>
  );
}

function SentenceFeedback({
  result,
  stale,
  applySentence,
  checkAgain,
}: {
  result: CheckResult;
  stale: boolean;
  applySentence: (value: string) => void;
  checkAgain: () => void;
}) {
  const title =
    result.verdict === "clear"
      ? "Your sentence is clear"
      : result.verdict === "needs_small_fix"
        ? "Your sentence needs a small fix"
        : result.verdict === "unclear"
          ? "I’m not fully sure what you mean yet."
          : "Your sentence can be clearer";
  return (
    <div className="rounded-2xl border-2 border-border bg-card p-4" aria-live="polite">
      <h3 className="text-lg font-extrabold text-heading">{title}</h3>
      {stale && (
        <p className="mt-2 rounded-lg bg-highlight p-2 text-sm font-bold">
          Your draft changed. Check it again for updated feedback.
        </p>
      )}
      <p className="mt-3 text-xs font-extrabold uppercase text-muted">Corrected sentence</p>
      <p className="mt-1 text-lg font-bold">{result.correctedSentence}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => applySentence(result.correctedSentence)}
          className="font-bold text-primary underline"
        >
          Use corrected sentence
        </button>
        <SpeakButton text={result.correctedSentence} label="Listen" />
      </div>
      {result.naturalAlternative && (
        <>
          <p className="mt-4 text-xs font-extrabold uppercase text-muted">More natural</p>
          <p className="mt-1 text-lg font-bold">{result.naturalAlternative}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => applySentence(result.naturalAlternative!)}
              className="font-bold text-primary underline"
            >
              Use natural version
            </button>
            <SpeakButton text={result.naturalAlternative} label="Listen" />
          </div>
        </>
      )}
      <p className="mt-4 text-xs font-extrabold uppercase text-muted">Why</p>
      <p className="mt-1 text-sm text-body">{result.explanationVi}</p>
      <p className="mt-4 text-sm font-bold">
        Now say the corrected sentence aloud without looking.
      </p>
      <button type="button" className="mt-3 font-bold text-primary underline" onClick={checkAgain}>
        Check again
      </button>
    </div>
  );
}

function Rating({
  enabled,
  choose,
}: {
  enabled: boolean;
  choose: (rating: "hard" | "okay" | "easy") => void;
}) {
  const options = [
    { value: "hard" as const, label: "Hard", help: "I needed the sentence or answer." },
    { value: "okay" as const, label: "Okay", help: "I could say it with some pauses." },
    { value: "easy" as const, label: "Easy", help: "I could say it without much help." },
  ];
  return (
    <div className="grid w-full gap-2 sm:grid-cols-3" aria-label="Self-rating">
      {options.map((option) => (
        <button
          key={option.value}
          disabled={!enabled}
          aria-label={`Rate this speaking item ${option.value}`}
          className="rounded-xl border-2 border-primary p-3 text-left text-primary disabled:cursor-not-allowed disabled:opacity-40 focus:outline-2 focus:outline-offset-2"
          onClick={() => choose(option.value)}
        >
          <strong className="block">{option.label}</strong>
          <span className="text-xs">{option.help}</span>
        </button>
      ))}
    </div>
  );
}

function Launcher({
  label,
  detail,
  start,
  back,
  busy,
}: {
  label: string;
  detail: string;
  start: () => void;
  back: () => void;
  busy: boolean;
}) {
  return (
    <section
      className="rounded-3xl border-2 border-border bg-card p-8 text-center"
      aria-busy={busy}
    >
      <h2 className="text-2xl font-extrabold">Guided Speaking Ladder</h2>
      <p className="my-4 text-body">{detail}</p>
      <button
        disabled={busy}
        className="rounded-full bg-primary px-6 py-3 font-bold text-white disabled:opacity-40"
        onClick={start}
      >
        {busy ? "Starting…" : label}
      </button>
      <button className="ml-3 font-bold text-primary" onClick={back}>
        Back
      </button>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-border p-3 text-center">
      <strong className="block text-xl">{value}</strong>
      {label}
    </div>
  );
}
