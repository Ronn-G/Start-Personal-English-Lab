import type { Lesson } from "../types/lesson";

export const AUDIO_DEFAULTS = {
  voice: "af_sarah",
  speed: 1,
  language: "en-us",
  modelVersion: "kokoro-v1.0",
  normalizationVersion: 1,
  format: "wav",
} as const;

export const AUDIO_SUPPORTED_VOICES = ["af_sarah"] as const;
export const AUDIO_SUPPORTED_LANGUAGES = ["en-us"] as const;
export const AUDIO_SUPPORTED_MODELS = ["kokoro-v1.0"] as const;
export const AUDIO_MIN_SPEED = 0.65;
export const AUDIO_MAX_SPEED = 1.35;
export const AUDIO_MAX_TEXT_CHARS = 650;
export const AUDIO_MAX_TEXT_BYTES = 2_600;

export interface AudioConfig {
  voice: string;
  speed: number;
  language: string;
  modelVersion: string;
  normalizationVersion: number;
  format: "wav";
}

export type AudioErrorCode =
  | "INVALID_AUDIO_REQUEST"
  | "AUDIO_CAPACITY_EXCEEDED"
  | "KOKORO_UNAVAILABLE"
  | "KOKORO_TIMEOUT"
  | "KOKORO_INVALID_RESPONSE"
  | "KOKORO_INVALID_WAV"
  | "AUDIO_REQUEST_CANCELLED"
  | "AUDIO_RETRY_COOLDOWN"
  | "AUDIO_RETRY_REQUIRED"
  | "AUDIO_STORAGE_FAILED"
  | "AUDIO_PLAYBACK_FAILED";

export type AudioRetryMode = "preload" | "automatic" | "manual";

export type AudioPreparationStatus =
  "queued" | "generating" | "retrying" | "ready" | "failed" | "cancelled";

export type AudioSourceType =
  | "vocabulary"
  | "idiom"
  | "grammar"
  | "example"
  | "shadowing"
  | "sentence-mining"
  | "listening"
  | "speaking"
  | "relisten";

export interface CanonicalAudioRequest extends AudioConfig {
  text: string;
}

export interface AudioPreloadItem {
  lessonId: string;
  itemId: string;
  text: string;
  sourceType: AudioSourceType;
  priority: number;
  config: AudioConfig;
}

export function normalizeAudioText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function rateToKokoroSpeed(rate: number): number {
  return Math.min(Math.max(rate / 0.86, 0.65), 1.35);
}

export function resolveAudioConfig(partial: Partial<AudioConfig> = {}): AudioConfig {
  if (
    partial.voice !== undefined &&
    (typeof partial.voice !== "string" ||
      !AUDIO_SUPPORTED_VOICES.includes(
        partial.voice.trim() as (typeof AUDIO_SUPPORTED_VOICES)[number],
      ))
  ) {
    throw new Error("INVALID_AUDIO_REQUEST");
  }
  if (
    partial.speed !== undefined &&
    (typeof partial.speed !== "number" ||
      !Number.isFinite(partial.speed) ||
      partial.speed < AUDIO_MIN_SPEED ||
      partial.speed > AUDIO_MAX_SPEED)
  ) {
    throw new Error("INVALID_AUDIO_REQUEST");
  }
  if (
    partial.language !== undefined &&
    (typeof partial.language !== "string" ||
      !AUDIO_SUPPORTED_LANGUAGES.includes(
        partial.language.trim() as (typeof AUDIO_SUPPORTED_LANGUAGES)[number],
      ))
  ) {
    throw new Error("INVALID_AUDIO_REQUEST");
  }
  if (
    partial.modelVersion !== undefined &&
    (typeof partial.modelVersion !== "string" ||
      !AUDIO_SUPPORTED_MODELS.includes(
        partial.modelVersion.trim() as (typeof AUDIO_SUPPORTED_MODELS)[number],
      ))
  ) {
    throw new Error("INVALID_AUDIO_REQUEST");
  }
  if (
    partial.normalizationVersion !== undefined &&
    partial.normalizationVersion !== AUDIO_DEFAULTS.normalizationVersion
  ) {
    throw new Error("INVALID_AUDIO_REQUEST");
  }
  if (partial.format !== undefined && partial.format !== AUDIO_DEFAULTS.format) {
    throw new Error("INVALID_AUDIO_REQUEST");
  }
  return {
    voice: partial.voice?.trim() || AUDIO_DEFAULTS.voice,
    speed:
      typeof partial.speed === "number" && Number.isFinite(partial.speed)
        ? partial.speed
        : AUDIO_DEFAULTS.speed,
    language: partial.language?.trim() || AUDIO_DEFAULTS.language,
    modelVersion: partial.modelVersion?.trim() || AUDIO_DEFAULTS.modelVersion,
    normalizationVersion:
      typeof partial.normalizationVersion === "number" &&
      Number.isInteger(partial.normalizationVersion)
        ? partial.normalizationVersion
        : AUDIO_DEFAULTS.normalizationVersion,
    format: partial.format === "wav" ? partial.format : AUDIO_DEFAULTS.format,
  };
}

export function buildCanonicalAudioRequest(
  text: string,
  partial: Partial<AudioConfig> = {},
): CanonicalAudioRequest {
  const normalized = normalizeAudioText(text);
  if (
    !normalized ||
    normalized.length > AUDIO_MAX_TEXT_CHARS ||
    new TextEncoder().encode(normalized).byteLength > AUDIO_MAX_TEXT_BYTES
  ) {
    throw new Error("INVALID_AUDIO_REQUEST");
  }
  return { text: normalized, ...resolveAudioConfig(partial) };
}

export function canonicalAudioInput(text: string, config: AudioConfig): string {
  return `text=${normalizeAudioText(text)}
voice=${config.voice}
speed=${config.speed}
language=${config.language}
model=${config.modelVersion}
normalization=${config.normalizationVersion}
format=${config.format}`;
}

export function canUseBrowserFallback(status: AudioPreparationStatus): boolean {
  return status === "failed";
}

export function canFallbackFromAudioError(code: AudioErrorCode): boolean {
  return [
    "KOKORO_UNAVAILABLE",
    "KOKORO_TIMEOUT",
    "KOKORO_INVALID_RESPONSE",
    "KOKORO_INVALID_WAV",
    "AUDIO_RETRY_COOLDOWN",
    "AUDIO_RETRY_REQUIRED",
  ].includes(code);
}

export function selectLessonAudioPreloadItems(lesson: Lesson, limit = 15): AudioPreloadItem[] {
  const raw: Array<Omit<AudioPreloadItem, "lessonId" | "config">> = [
    ...lesson.deepPractice.shadowingPractice.lines.slice(0, 5).map((item) => ({
      itemId: item.id,
      text: item.line,
      sourceType: "shadowing" as const,
      priority: 2,
    })),
    ...lesson.exampleSentences.slice(0, 5).map((item) => ({
      itemId: item.id,
      text: item.sentence,
      sourceType: "example" as const,
      priority: 3,
    })),
    ...lesson.deepPractice.sentenceMining.slice(0, 3).map((item) => ({
      itemId: item.id,
      text: item.sentence,
      sourceType: "sentence-mining" as const,
      priority: 4,
    })),
    ...lesson.vocabulary
      .filter((item) => item.context)
      .slice(0, 5)
      .map((item) => ({
        itemId: item.id,
        text: item.context!,
        sourceType: "vocabulary" as const,
        priority: 5,
      })),
  ];
  const seen = new Set<string>();
  return raw
    .filter((item) => {
      const normalized = normalizeAudioText(item.text);
      if (!normalized || normalized.length > 650 || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    })
    .slice(0, limit)
    .map((item) => ({
      ...item,
      lessonId: lesson.id,
      config: {
        ...AUDIO_DEFAULTS,
        speed: rateToKokoroSpeed(item.sourceType === "shadowing" ? 0.78 : 0.82),
      },
    }));
}

export interface QueueJob {
  key: string;
  request: () => Promise<string>;
  priority: number;
  lessonId: string;
  status: AudioPreparationStatus;
  queuedAt: number;
  listeners: Map<(status: AudioPreparationStatus) => void, string>;
  lessonIds: Set<string>;
}

type InternalQueueJob = QueueJob & {
  resolve?: (value: string) => void;
  reject?: (error: unknown) => void;
};

export class AudioQueue {
  private jobs = new Map<string, InternalQueueJob>();
  private waiters = new Map<string, Promise<string>>();
  private active = 0;

  constructor(private concurrency = 1) {}

  enqueue(
    job: Omit<QueueJob, "status" | "queuedAt" | "listeners" | "lessonIds"> & {
      onStatus?: (status: AudioPreparationStatus) => void;
    },
  ): Promise<string> {
    const old = this.jobs.get(job.key);
    if (old && job.priority < old.priority) old.priority = job.priority;
    if (old) old.lessonIds.add(job.lessonId);
    if (old && job.onStatus) {
      old.listeners.set(job.onStatus, job.lessonId);
      job.onStatus(old.status);
    }
    const waiting = this.waiters.get(job.key);
    if (waiting) return waiting;

    const listeners = new Map<(status: AudioPreparationStatus) => void, string>();
    if (job.onStatus) listeners.set(job.onStatus, job.lessonId);
    const full: InternalQueueJob = {
      key: job.key,
      request: job.request,
      priority: job.priority,
      lessonId: job.lessonId,
      status: "queued",
      queuedAt: Date.now(),
      listeners,
      lessonIds: new Set([job.lessonId]),
    };
    const promise = new Promise<string>((resolve, reject) => {
      full.resolve = resolve;
      full.reject = reject;
    });
    this.jobs.set(job.key, full);
    this.waiters.set(job.key, promise);
    this.notify(full, "queued");
    this.pump();
    return promise;
  }

  cancelLesson(id: string) {
    for (const job of this.jobs.values()) {
      job.lessonIds.delete(id);
      for (const [listener, lessonId] of job.listeners) {
        if (lessonId === id) job.listeners.delete(listener);
      }
      if (job.lessonIds.size === 0 && job.status === "queued" && job.priority > 1) {
        this.notify(job, "cancelled");
        job.reject?.(new Error("AUDIO_REQUEST_CANCELLED"));
        this.finish(job.key);
      }
    }
  }

  private notify(job: InternalQueueJob, status: AudioPreparationStatus) {
    job.status = status;
    for (const listener of job.listeners.keys()) listener(status);
  }

  private finish(key: string) {
    this.jobs.delete(key);
    this.waiters.delete(key);
  }

  private pump() {
    while (this.active < this.concurrency) {
      const next = [...this.jobs.values()]
        .filter((item) => item.status === "queued")
        .sort((left, right) => left.priority - right.priority || left.queuedAt - right.queuedAt)[0];
      if (!next) return;
      this.notify(next, "generating");
      this.active += 1;
      next
        .request()
        .then((value) => {
          this.notify(next, "ready");
          next.resolve?.(value);
        })
        .catch((error) => {
          this.notify(next, "failed");
          next.reject?.(error);
        })
        .finally(() => {
          this.active -= 1;
          this.finish(next.key);
          this.pump();
        });
    }
  }
}
