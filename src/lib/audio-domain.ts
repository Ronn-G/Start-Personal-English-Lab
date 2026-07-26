import type { Lesson } from "../types/lesson";

export const AUDIO_DEFAULTS = {
  voice: "af_sarah",
  speed: 1,
  language: "en-us",
  modelVersion: "kokoro-v1.0",
  normalizationVersion: 1,
  format: "wav",
} as const;

export interface AudioConfig {
  voice: string;
  speed: number;
  language: string;
  modelVersion: string;
  normalizationVersion: number;
  format: "wav";
}

export type AudioPreparationStatus = "queued" | "generating" | "ready" | "failed" | "cancelled";

export interface AudioPreloadItem {
  lessonId: string;
  itemId: string;
  text: string;
  sourceType: "shadowing" | "example" | "sentence-mining" | "vocabulary";
  priority: number;
  config: AudioConfig;
}

export function normalizeAudioText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function rateToKokoroSpeed(rate: number): number {
  return Math.min(Math.max(rate / 0.86, 0.65), 1.35);
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
  listeners: Set<(status: AudioPreparationStatus) => void>;
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
    job: Omit<QueueJob, "status" | "queuedAt" | "listeners"> & {
      onStatus?: (status: AudioPreparationStatus) => void;
    },
  ): Promise<string> {
    const old = this.jobs.get(job.key);
    if (old && job.priority < old.priority) old.priority = job.priority;
    if (old && job.onStatus) {
      old.listeners.add(job.onStatus);
      job.onStatus(old.status);
    }
    const waiting = this.waiters.get(job.key);
    if (waiting) return waiting;

    const listeners = new Set<(status: AudioPreparationStatus) => void>();
    if (job.onStatus) listeners.add(job.onStatus);
    const full: InternalQueueJob = {
      key: job.key,
      request: job.request,
      priority: job.priority,
      lessonId: job.lessonId,
      status: "queued",
      queuedAt: Date.now(),
      listeners,
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
      if (job.lessonId === id && job.status === "queued" && job.priority > 1) {
        this.notify(job, "cancelled");
        job.reject?.(new Error("cancelled"));
        this.finish(job.key);
      }
    }
  }

  private notify(job: InternalQueueJob, status: AudioPreparationStatus) {
    job.status = status;
    for (const listener of job.listeners) listener(status);
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
