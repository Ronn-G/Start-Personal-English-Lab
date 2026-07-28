"use client";

import { useId } from "react";

import { useAppAudio } from "@/hooks/useAppAudio";
import type { AudioSourceType } from "@/lib/audio-domain";

interface SpeakButtonProps {
  text: string;
  label?: string;
  rate?: number;
  lessonId?: string;
  itemId?: string;
  sourceType?: AudioSourceType;
}

export default function SpeakButton({
  text,
  label = "Nghe",
  rate = 0.86,
  lessonId = "user",
  itemId,
  sourceType = "example",
}: SpeakButtonProps) {
  const generatedId = useId();
  const audioId = itemId ?? `${sourceType}:${generatedId}`;
  const playback = useAppAudio(`${lessonId}:${generatedId}`);
  const status = playback.audioStatus(audioId);
  const active = playback.state.itemId === audioId;

  function handlePlay(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (!text.trim()) return;
    if (active && (playback.state.playing || playback.state.loading)) {
      playback.stop();
      return;
    }
    void playback.play(audioId, text, 1, rate, true, sourceType);
  }

  function handleRetry(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    void playback.retryKokoro(audioId, text, rate, sourceType);
  }

  const visibleStatus =
    status.status === "preparing"
      ? "Preparing Kokoro audio"
      : status.status === "retrying"
        ? "Retrying Kokoro"
        : status.status === "ready"
          ? "Kokoro audio ready"
          : status.status === "browser"
            ? "Using browser voice"
            : status.status === "failed"
              ? "Audio failed"
              : null;

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={handlePlay}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full border-2 border-border bg-card px-3 py-1.5 text-xs font-extrabold text-primary shadow-sm transition ease-smooth hover:border-primary hover:bg-white focus:outline-2 focus:outline-offset-2"
        aria-label={`${active && (playback.state.playing || playback.state.loading) ? "Stop" : label}: ${text}`}
      >
        <span aria-hidden="true">🔊</span>
        {active && playback.state.loading
          ? "Preparing..."
          : active && playback.state.playing
            ? "Stop"
            : label}
      </button>
      {visibleStatus ? (
        <span className="text-[11px] text-muted" role="status">
          {visibleStatus}
        </span>
      ) : null}
      {(status.status === "failed" || status.status === "browser") && status.retryable !== false ? (
        <button
          type="button"
          onClick={handleRetry}
          className="text-xs font-bold text-primary underline focus:outline-2 focus:outline-offset-2"
        >
          Retry Kokoro
        </button>
      ) : null}
    </span>
  );
}
