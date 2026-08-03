"use client";

import type { useAppAudio } from "@/hooks/useAppAudio";
import type { AudioSourceType } from "@/lib/audio-domain";

type Playback = ReturnType<typeof useAppAudio>;

export interface ListeningAudioItem {
  id: string;
  text: string;
}

function AudioStatusLine({
  itemId,
  text,
  rate,
  playback,
  sourceType = "listening",
}: {
  itemId: string;
  text: string;
  rate: number;
  playback: Playback;
  sourceType?: AudioSourceType;
}) {
  const active = playback.state.itemId === itemId;
  const audio = playback.audioStatus(itemId);
  const audioLabel =
    audio.status === "ready"
      ? "Kokoro audio ready"
      : audio.status === "browser"
        ? "Using browser voice"
        : audio.status === "failed"
          ? "Audio failed"
          : audio.status === "retrying"
            ? "Retrying Kokoro audio"
            : audio.status === "preparing"
              ? "Preparing Kokoro audio"
              : "Kokoro audio starts on Play";
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs font-bold text-muted">
      <span role="status">{audioLabel}</span>
      {audio.status === "browser" || audio.status === "failed" ? (
        <button
          type="button"
          disabled={active && playback.state.loading}
          onClick={() => void playback.retryKokoro(itemId, text, rate, sourceType)}
          className="text-primary underline disabled:cursor-wait disabled:opacity-50"
        >
          {active && playback.state.loading ? "Retrying Kokoro..." : "Retry Kokoro"}
        </button>
      ) : null}
    </div>
  );
}

export function ListeningAudioControls({
  item,
  rate,
  playback,
  loops = false,
}: {
  item: ListeningAudioItem;
  rate: number;
  playback: Playback;
  loops?: boolean;
}) {
  const active = playback.state.itemId === item.id;
  return (
    <div>
      <AudioStatusLine itemId={item.id} text={item.text} rate={rate} playback={playback} />
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={active && playback.state.loading}
          onClick={() => void playback.play(item.id, item.text, 1, rate)}
          className="rounded-full bg-primary px-4 py-2 text-sm font-bold text-white disabled:cursor-wait disabled:opacity-50"
        >
          {active && playback.state.loading && playback.state.target === 1
            ? "Preparing..."
            : "Play"}
        </button>
        {active && (playback.state.playing || playback.state.paused) ? (
          <button
            type="button"
            onClick={playback.togglePause}
            className="rounded-full border-2 border-primary px-4 py-2 text-sm font-bold text-primary"
          >
            {playback.state.paused ? "Continue" : "Pause"}
          </button>
        ) : null}
        {loops ? (
          <>
            {[3, 5].map((count) => (
              <button
                key={count}
                type="button"
                disabled={active && playback.state.loading}
                onClick={() => void playback.play(item.id, item.text, count, rate)}
                className="rounded-full border-2 border-primary px-4 py-2 text-sm font-bold text-primary disabled:cursor-wait disabled:opacity-50"
              >
                Loop {count}
              </button>
            ))}
          </>
        ) : null}
        <button
          type="button"
          disabled={
            !active ||
            (!playback.state.loading && !playback.state.playing && !playback.state.paused)
          }
          onClick={() => playback.stop(true)}
          className="rounded-full border-2 border-border px-4 py-2 text-sm font-bold disabled:opacity-40"
        >
          Stop
        </button>
      </div>
      {active && playback.state.target > 1 ? (
        <p role="status" className="mt-2 text-sm font-bold text-muted">
          {playback.state.loading
            ? "Preparing Kokoro audio"
            : `Listened ${playback.state.completed} of ${playback.state.target}`}
        </p>
      ) : null}
    </div>
  );
}

export function PracticeTrack({
  track,
  rate,
  setRate,
  playback,
}: {
  track: string;
  rate: number;
  setRate: (value: number) => void;
  playback: Playback;
}) {
  const active = playback.state.itemId === "track";
  return (
    <div className="rounded-2xl border-2 border-border p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-extrabold text-heading">Kokoro practice audio</p>
          <p className="text-sm text-muted">
            Built from the same selected sentences used in Check Meaning and Sentence Review.
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
      <div className="mt-4">
        <AudioStatusLine itemId="track" text={track} rate={rate} playback={playback} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!track || (active && playback.state.loading)}
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
          disabled={
            !active ||
            (!playback.state.loading && !playback.state.playing && !playback.state.paused)
          }
          onClick={() => playback.stop(false)}
          className="rounded-full border-2 border-border px-4 py-2 font-bold disabled:opacity-40"
        >
          Stop
        </button>
        <button
          type="button"
          disabled={!track || (active && playback.state.loading)}
          onClick={() => void playback.play("track", track, 1, rate)}
          className="rounded-full border-2 border-border px-4 py-2 font-bold disabled:opacity-40"
        >
          Replay
        </button>
      </div>
    </div>
  );
}
