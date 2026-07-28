"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AudioClientError, audioClient } from "@/lib/audio-client";
import {
  AUDIO_DEFAULTS,
  canFallbackFromAudioError,
  rateToKokoroSpeed,
  type AudioErrorCode,
  type AudioPreparationStatus,
  type AudioPreloadItem,
  type AudioSourceType,
} from "@/lib/audio-domain";

export interface AppPlaybackState {
  itemId: string | null;
  loading: boolean;
  playing: boolean;
  paused: boolean;
  completed: number;
  target: number;
  source?: "kokoro" | "browser";
  error?: string;
}

export type AppAudioStatus = "idle" | "preparing" | "retrying" | "ready" | "browser" | "failed";

export interface AppAudioItemState {
  status: AppAudioStatus;
  error?: string;
  errorCode?: AudioErrorCode;
  retryable?: boolean;
  nextRetryAt?: string | null;
}

interface PlaybackRun {
  itemId: string;
  text: string;
  target: number;
  completed: number;
  rate: number;
  recorded: boolean;
  source: "kokoro" | "browser" | null;
}

let activeOwner: symbol | undefined;
let stopActivePlayback: (() => void) | undefined;

export function useAppAudio(
  lessonId: string,
  onRecorded: (itemId: string, repetitions: number) => void = () => undefined,
) {
  const ownerRef = useRef(Symbol("audio-owner"));
  const mountedRef = useRef(true);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const runRef = useRef<PlaybackRun | null>(null);
  const finishOneRef = useRef<() => void>(() => undefined);
  const onRecordedRef = useRef(onRecorded);
  const [state, setState] = useState<AppPlaybackState>({
    itemId: null,
    loading: false,
    playing: false,
    paused: false,
    completed: 0,
    target: 0,
  });
  const [items, setItems] = useState<Record<string, AppAudioItemState>>({});

  useEffect(() => {
    onRecordedRef.current = onRecorded;
  }, [onRecorded]);

  const setItem = useCallback((itemId: string, next: AppAudioItemState) => {
    if (!mountedRef.current) return;
    setItems((current) => ({ ...current, [itemId]: next }));
  }, []);

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
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      if (recordCompleted) recordRun();
      runRef.current = null;
      if (activeOwner === ownerRef.current) {
        activeOwner = undefined;
        stopActivePlayback = undefined;
      }
      if (mountedRef.current) {
        setState((current) => ({
          ...current,
          loading: false,
          playing: false,
          paused: false,
        }));
      }
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
    if (run.source === "kokoro" && audioRef.current) {
      audioRef.current.currentTime = 0;
      void audioRef.current.play().catch(() => {
        setItem(run.itemId, {
          status: "failed",
          error: "The browser could not play Kokoro audio.",
          errorCode: "AUDIO_PLAYBACK_FAILED",
          retryable: true,
        });
        setState((current) => ({
          ...current,
          playing: false,
          error: "Kokoro audio could not play. Try Play again.",
        }));
      });
      return;
    }
    if (run.source === "browser" && "speechSynthesis" in window) {
      const utterance = new SpeechSynthesisUtterance(run.text);
      utterance.lang = "en-US";
      utterance.rate = run.rate;
      utterance.onend = () => finishOneRef.current();
      utterance.onerror = () => {
        setItem(run.itemId, {
          status: "failed",
          error: "Browser voice stopped.",
          errorCode: "AUDIO_PLAYBACK_FAILED",
          retryable: true,
        });
        setState((current) => ({
          ...current,
          playing: false,
          error: "Browser voice stopped.",
        }));
      };
      window.speechSynthesis.speak(utterance);
    }
  }, [recordRun, setItem]);

  useEffect(() => {
    finishOneRef.current = finishOne;
  }, [finishOne]);

  const playBrowserFallback = useCallback(
    (run: PlaybackRun, failure: AudioClientError) => {
      if (
        !failure.retryable ||
        !canFallbackFromAudioError(failure.error) ||
        !("speechSynthesis" in window) ||
        runRef.current !== run
      ) {
        return false;
      }
      run.source = "browser";
      const utterance = new SpeechSynthesisUtterance(run.text);
      utterance.lang = "en-US";
      utterance.rate = run.rate;
      const voice = window.speechSynthesis.getVoices().find((item) => item.lang.startsWith("en"));
      if (voice) utterance.voice = voice;
      utterance.onend = () => finishOneRef.current();
      utterance.onerror = () => {
        setItem(run.itemId, {
          status: "failed",
          error: "Browser voice stopped.",
          errorCode: "AUDIO_PLAYBACK_FAILED",
          retryable: true,
        });
        setState((current) => ({
          ...current,
          playing: false,
          error: "Browser voice stopped.",
        }));
      };
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
      setItem(run.itemId, {
        status: "browser",
        error: failure.summary,
        errorCode: failure.error,
        retryable: failure.retryable,
        nextRetryAt: failure.nextRetryAt,
      });
      setState((current) => ({
        ...current,
        loading: false,
        playing: true,
        source: "browser",
        error: undefined,
      }));
      return true;
    },
    [setItem],
  );

  const play = useCallback(
    async (
      itemId: string,
      text: string,
      target = 1,
      rate = 0.86,
      allowBrowserFallback = true,
      sourceType: AudioSourceType = "listening",
    ) => {
      if (stopActivePlayback && activeOwner !== ownerRef.current) stopActivePlayback();
      stop(true);
      activeOwner = ownerRef.current;
      stopActivePlayback = () => stop(false);
      const run: PlaybackRun = {
        itemId,
        text,
        target,
        completed: 0,
        rate,
        recorded: false,
        source: null,
      };
      runRef.current = run;
      setItem(itemId, { status: "preparing" });
      setState({
        itemId,
        loading: true,
        playing: false,
        paused: false,
        completed: 0,
        target,
      });
      let url: string;
      try {
        url = await audioClient.prepare(
          text,
          lessonId,
          rate,
          (status) => {
            if (runRef.current !== run) return;
            if (status === "queued" || status === "generating") {
              setItem(itemId, { status: "preparing" });
            } else if (status === "retrying") {
              setItem(itemId, { status: "retrying" });
            } else if (status === "ready") {
              setItem(itemId, { status: "ready" });
            }
          },
          { retryMode: "automatic", sourceType },
        );
      } catch (error) {
        if (runRef.current !== run) return;
        const failure =
          error instanceof AudioClientError
            ? error
            : new AudioClientError("KOKORO_UNAVAILABLE", "Kokoro is unavailable.", true);
        if (allowBrowserFallback && playBrowserFallback(run, failure)) return;
        setItem(itemId, {
          status: "failed",
          error: failure.summary,
          errorCode: failure.error,
          retryable: failure.retryable,
          nextRetryAt: failure.nextRetryAt,
        });
        setState((current) => ({
          ...current,
          loading: false,
          playing: false,
          error: failure.summary,
        }));
        return;
      }
      if (runRef.current !== run) return;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => finishOneRef.current();
      audio.onerror = () => {
        if (runRef.current !== run) return;
        setItem(itemId, {
          status: "failed",
          error: "The browser could not play Kokoro audio.",
          errorCode: "AUDIO_PLAYBACK_FAILED",
          retryable: true,
        });
        setState((current) => ({
          ...current,
          loading: false,
          playing: false,
          error: "Kokoro audio could not play. Try Play again.",
        }));
      };
      try {
        await audio.play();
        if (runRef.current !== run) {
          audio.pause();
          return;
        }
        run.source = "kokoro";
        setItem(itemId, { status: "ready" });
        setState((current) => ({
          ...current,
          loading: false,
          playing: true,
          source: "kokoro",
          error: undefined,
        }));
      } catch {
        if (runRef.current !== run) return;
        setItem(itemId, {
          status: "failed",
          error: "The browser could not start Kokoro audio.",
          errorCode: "AUDIO_PLAYBACK_FAILED",
          retryable: true,
        });
        setState((current) => ({
          ...current,
          loading: false,
          playing: false,
          error: "Kokoro audio could not start. Try Play again.",
        }));
      }
    },
    [lessonId, playBrowserFallback, setItem, stop],
  );

  const retryKokoro = useCallback(
    async (
      itemId: string,
      text: string,
      rate: number,
      sourceType: AudioSourceType = "listening",
    ) => {
      setItem(itemId, { status: "retrying" });
      try {
        await audioClient.prepare(
          text,
          lessonId,
          rate,
          (status) => {
            if (status === "queued" || status === "generating" || status === "retrying") {
              setItem(itemId, { status: "retrying" });
            }
          },
          { retryMode: "manual", sourceType },
        );
        setItem(itemId, { status: "ready" });
      } catch (error) {
        const failure =
          error instanceof AudioClientError
            ? error
            : new AudioClientError("KOKORO_UNAVAILABLE", "Kokoro is unavailable.", true);
        setItem(itemId, {
          status: "failed",
          error: failure.summary,
          errorCode: failure.error,
          retryable: failure.retryable,
          nextRetryAt: failure.nextRetryAt,
        });
      }
    },
    [lessonId, setItem],
  );

  const preload = useCallback(
    (preloadItems: Array<{ id: string; text: string; sourceType: string }>, rate: number) => {
      const itemsToLoad: AudioPreloadItem[] = preloadItems.map((item, index) => ({
        lessonId,
        itemId: item.id,
        text: item.text,
        sourceType:
          item.sourceType === "sentence_mining"
            ? "sentence-mining"
            : (item.sourceType as AudioSourceType),
        priority: index + 1,
        config: { ...AUDIO_DEFAULTS, speed: rateToKokoroSpeed(rate) },
      }));
      void audioClient.preload(itemsToLoad, undefined, (item, status: AudioPreparationStatus) => {
        if (status === "queued" || status === "generating") {
          setItem(item.itemId, { status: "preparing" });
        } else if (status === "ready") {
          setItem(item.itemId, { status: "ready" });
        } else if (status === "failed") {
          setItem(item.itemId, {
            status: "failed",
            error: "Kokoro audio requires an explicit retry.",
            retryable: true,
          });
        }
      });
    },
    [lessonId, setItem],
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
    const owner = ownerRef.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      audioRef.current?.pause();
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
      runRef.current = null;
      audioClient.cancelLesson(lessonId);
      if (activeOwner === owner) {
        activeOwner = undefined;
        stopActivePlayback = undefined;
      }
    };
  }, [lessonId]);

  const audioStatus = useCallback(
    (itemId: string): AppAudioItemState => items[itemId] ?? { status: "idle" },
    [items],
  );

  return { state, play, retryKokoro, preload, audioStatus, stop, togglePause };
}
