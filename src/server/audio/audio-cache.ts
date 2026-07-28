import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  buildCanonicalAudioRequest,
  canonicalAudioInput,
  type AudioConfig,
  type AudioErrorCode,
  type AudioRetryMode,
  type AudioSourceType,
} from "../../lib/audio-domain";
import { resolveDataDirectory } from "../storage/data-directory";

export const AUDIO_CACHE_LIMIT = 500 * 1024 * 1024;
export const AUDIO_PROVIDER_TIMEOUT_MS = 30_000;
export const AUDIO_HEALTH_TIMEOUT_MS = 2_000;
export const AUDIO_AUTOMATIC_RETRY_LIMIT = 5;

const retryDelaysMs = [5_000, 15_000, 60_000, 300_000] as const;
let providerCircuitUntil = 0;
let lastProviderErrorCode: AudioErrorCode | null = null;

export interface AudioResult {
  cacheKey: string;
  url: string;
  cacheHit: boolean;
  sizeBytes: number;
  provider: "kokoro";
  status: "ready";
}

export interface AudioPrepareOptions {
  priority?: number;
  retryMode?: AudioRetryMode;
  sourceType?: AudioSourceType;
}

export interface AudioDeps {
  database: DatabaseSync;
  root?: string;
  fetcher?: typeof fetch;
  limit?: number;
  now?: () => Date;
}

interface AudioCacheRow {
  cache_key: string;
  status: "generating" | "ready" | "failed" | "stale";
  relative_path: string | null;
  size_bytes: number | null;
  failure_count: number;
  error_code: string | null;
  retryable: number | null;
  last_attempt_at: string | null;
  next_retry_at: string | null;
}

interface QueuedSynthesis {
  key: string;
  priority: number;
  queuedAt: number;
  task: () => Promise<AudioResult>;
  resolve: (result: AudioResult) => void;
  reject: (reason: unknown) => void;
}

export class ServerSynthesisQueue {
  private pending: QueuedSynthesis[] = [];
  private shared = new Map<string, Promise<AudioResult>>();
  private active = 0;

  enqueue(key: string, priority: number, task: () => Promise<AudioResult>): Promise<AudioResult> {
    const existing = this.shared.get(key);
    if (existing) return existing;
    let resolve!: (result: AudioResult) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<AudioResult>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    this.shared.set(key, promise);
    this.pending.push({ key, priority, queuedAt: Date.now(), task, resolve, reject });
    this.pump();
    return promise;
  }

  info() {
    return { concurrency: 1, active: this.active, queued: this.pending.length };
  }

  private pump() {
    if (this.active >= 1) return;
    const next = this.pending.sort(
      (left, right) => left.priority - right.priority || left.queuedAt - right.queuedAt,
    )[0];
    if (!next) return;
    this.pending = this.pending.filter((item) => item !== next);
    this.active += 1;
    void this.run(next);
  }

  private async run(next: QueuedSynthesis) {
    try {
      next.resolve(await next.task());
    } catch (error) {
      next.reject(error);
    } finally {
      this.active -= 1;
      this.shared.delete(next.key);
      this.pump();
    }
  }
}

const audioGlobal = globalThis as typeof globalThis & {
  __personalEnglishLabAudioQueue?: ServerSynthesisQueue;
};
const synthesisQueue = (audioGlobal.__personalEnglishLabAudioQueue ??= new ServerSynthesisQueue());

export class AudioServiceError extends Error {
  constructor(
    public readonly code: AudioErrorCode,
    public readonly httpStatus: number,
    public readonly retryable: boolean,
    public readonly safeSummary: string,
    public readonly nextRetryAt: string | null = null,
    public readonly causeCode?: string,
  ) {
    super(code);
    this.name = "AudioServiceError";
  }
}

export function audioCacheKey(text: string, config: AudioConfig): string {
  return createHash("sha256").update(canonicalAudioInput(text, config)).digest("hex");
}

export function validWav(data: Uint8Array, type = "audio/wav") {
  return (
    type.toLowerCase().includes("audio") &&
    data.length > 44 &&
    Buffer.from(data.subarray(0, 4)).toString() === "RIFF" &&
    Buffer.from(data.subarray(8, 12)).toString() === "WAVE"
  );
}

export function cleanupPlan(
  rows: Array<{
    cache_key: string;
    size_bytes: number;
    last_accessed_at: string | null;
    status: string;
  }>,
  limit: number,
  protect?: string,
) {
  let total = rows.reduce((sum, row) => sum + row.size_bytes, 0);
  const remove: string[] = [];
  for (const row of [...rows]
    .filter((item) => item.status === "ready" && item.cache_key !== protect)
    .sort((left, right) =>
      (left.last_accessed_at ?? "").localeCompare(right.last_accessed_at ?? ""),
    )) {
    if (total <= limit) break;
    total -= row.size_bytes;
    remove.push(row.cache_key);
  }
  return remove;
}

export function resolveKokoroBaseUrl(value = process.env.KOKORO_BASE_URL): string {
  const normalized = value?.trim().replace(/\/+$/, "");
  if (!normalized) return "http://127.0.0.1:5050";
  const url = new URL(normalized);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("INVALID_KOKORO_BASE_URL");
  }
  return url.toString().replace(/\/+$/, "");
}

export function serverAudioQueueInfo() {
  return synthesisQueue.info();
}

function safeSummary(code: AudioErrorCode): string {
  const summaries: Record<AudioErrorCode, string> = {
    INVALID_AUDIO_REQUEST: "The audio request is invalid.",
    KOKORO_UNAVAILABLE: "Kokoro is unavailable.",
    KOKORO_TIMEOUT: "Kokoro took too long to respond.",
    KOKORO_INVALID_RESPONSE: "Kokoro returned invalid audio.",
    KOKORO_INVALID_WAV: "Kokoro returned an invalid WAV file.",
    AUDIO_REQUEST_CANCELLED: "The audio request was cancelled.",
    AUDIO_RETRY_COOLDOWN: "Kokoro retry is cooling down.",
    AUDIO_RETRY_REQUIRED: "Manual Kokoro retry is required.",
    AUDIO_STORAGE_FAILED: "The audio file could not be stored.",
    AUDIO_PLAYBACK_FAILED: "The browser could not play the audio.",
  };
  return summaries[code];
}

function retryDelay(attempt: number): number {
  return retryDelaysMs[Math.min(Math.max(attempt - 1, 0), retryDelaysMs.length - 1)];
}

function causeCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return;
  const cause = error.cause;
  if (cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string") {
    return cause.code.slice(0, 40);
  }
  return error.name === "AbortError" ? "ABORT_ERR" : undefined;
}

function classifyProviderError(error: unknown): AudioServiceError {
  if (error instanceof AudioServiceError) return error;
  const code = causeCode(error);
  if (
    code === "ABORT_ERR" ||
    (error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted")))
  ) {
    return new AudioServiceError(
      "KOKORO_TIMEOUT",
      504,
      true,
      safeSummary("KOKORO_TIMEOUT"),
      null,
      code,
    );
  }
  if (code && ["EACCES", "EPERM", "ENOSPC", "EROFS"].includes(code)) {
    return new AudioServiceError(
      "AUDIO_STORAGE_FAILED",
      500,
      true,
      safeSummary("AUDIO_STORAGE_FAILED"),
      null,
      code,
    );
  }
  return new AudioServiceError(
    "KOKORO_UNAVAILABLE",
    503,
    true,
    safeSummary("KOKORO_UNAVAILABLE"),
    null,
    code,
  );
}

export class AudioCacheService {
  private root: string;
  private fetcher: typeof fetch;
  private kokoroBaseUrl: string;
  private now: () => Date;

  constructor(private deps: AudioDeps) {
    this.root = deps.root ?? join(resolveDataDirectory(), "audio-cache");
    this.fetcher = deps.fetcher ?? fetch;
    this.kokoroBaseUrl = resolveKokoroBaseUrl();
    this.now = deps.now ?? (() => new Date());
  }

  async prepare(
    text: string,
    partial: Partial<AudioConfig> = {},
    options: AudioPrepareOptions = {},
  ): Promise<AudioResult> {
    let request;
    try {
      request = buildCanonicalAudioRequest(text, partial);
    } catch {
      throw new AudioServiceError(
        "INVALID_AUDIO_REQUEST",
        400,
        false,
        safeSummary("INVALID_AUDIO_REQUEST"),
      );
    }
    const { text: normalized, ...config } = request;
    const key = audioCacheKey(normalized, config);
    const hit = await this.hit(key);
    if (hit) return hit;

    const retryMode = options.retryMode ?? "automatic";
    const row = this.row(key);
    this.assertRetryAllowed(row, retryMode);

    return synthesisQueue.enqueue(key, options.priority ?? 0, () =>
      this.generate(key, normalized, config, retryMode),
    );
  }

  async read(key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) {
      throw new AudioServiceError(
        "INVALID_AUDIO_REQUEST",
        400,
        false,
        safeSummary("INVALID_AUDIO_REQUEST"),
      );
    }
    const hit = await this.hit(key);
    if (!hit) {
      throw new AudioServiceError(
        "AUDIO_STORAGE_FAILED",
        404,
        true,
        "The cached audio file is missing or invalid.",
      );
    }
    return readFile(join(this.root, `${key}.wav`));
  }

  async health() {
    const checkedAt = this.now().toISOString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AUDIO_HEALTH_TIMEOUT_MS);
    try {
      const response = await this.fetcher(`${this.kokoroBaseUrl}/health`, {
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => ({}))) as {
        status?: string;
        modelLoaded?: boolean;
      };
      const reachable = response.ok && body.status === "ok" && body.modelLoaded === true;
      if (reachable) {
        providerCircuitUntil = 0;
        lastProviderErrorCode = null;
      }
      return {
        configured: true,
        reachable,
        provider: "kokoro" as const,
        status: reachable ? ("ready" as const) : ("unavailable" as const),
        checkedAt,
        error: reachable ? null : "KOKORO_UNAVAILABLE",
      };
    } catch (error) {
      const classified = classifyProviderError(error);
      lastProviderErrorCode = classified.code;
      return {
        configured: true,
        reachable: false,
        provider: "kokoro" as const,
        status: "unavailable" as const,
        checkedAt,
        error: classified.code,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async info() {
    const rows = this.deps.database
      .prepare(
        `SELECT status,COUNT(*) count,COALESCE(SUM(size_bytes),0) bytes
         FROM audio_cache GROUP BY status`,
      )
      .all() as Array<{ status: string; count: number; bytes: number }>;
    const counts = { ready: 0, failed: 0, generating: 0, stale: 0 };
    let bytes = 0;
    for (const row of rows) {
      if (row.status in counts) counts[row.status as keyof typeof counts] = row.count;
      if (row.status === "ready") bytes = row.bytes;
    }
    const latest = this.deps.database
      .prepare(
        `SELECT error_code,error_summary,updated_at
         FROM audio_cache WHERE status='failed' ORDER BY updated_at DESC LIMIT 1`,
      )
      .get() as
      { error_code: string | null; error_summary: string | null; updated_at: string } | undefined;
    return {
      count: counts.ready,
      bytes,
      ...counts,
      queue: synthesisQueue.info(),
      lastError: latest
        ? {
            code: latest.error_code,
            summary: latest.error_summary,
            at: latest.updated_at,
          }
        : lastProviderErrorCode
          ? { code: lastProviderErrorCode, summary: safeSummary(lastProviderErrorCode), at: null }
          : null,
    };
  }

  async repairInvalidEntries() {
    const rows = this.deps.database
      .prepare("SELECT cache_key,relative_path,size_bytes FROM audio_cache WHERE status='ready'")
      .all() as Array<{
      cache_key: string;
      relative_path: string | null;
      size_bytes: number | null;
    }>;
    let repaired = 0;
    for (const row of rows) {
      const valid = await this.validReadyFile(row.cache_key, row.relative_path, row.size_bytes);
      if (!valid) {
        this.markStale(row.cache_key);
        repaired += 1;
      }
    }
    return { repaired, ...(await this.info()) };
  }

  async clear() {
    await mkdir(this.root, { recursive: true });
    const rows = this.deps.database
      .prepare("SELECT cache_key FROM audio_cache WHERE status!='generating'")
      .all() as { cache_key: string }[];
    for (const row of rows) {
      await rm(join(this.root, `${row.cache_key}.wav`), { force: true });
    }
    this.deps.database.prepare("DELETE FROM audio_cache WHERE status!='generating'").run();
    return this.info();
  }

  private row(key: string): AudioCacheRow | undefined {
    return this.deps.database
      .prepare(
        `SELECT cache_key,status,relative_path,size_bytes,failure_count,error_code,
                retryable,last_attempt_at,next_retry_at
         FROM audio_cache WHERE cache_key=?`,
      )
      .get(key) as AudioCacheRow | undefined;
  }

  private assertRetryAllowed(row: AudioCacheRow | undefined, mode: AudioRetryMode) {
    if (!row || (row.status !== "failed" && row.status !== "stale")) return;
    if (row.retryable === 0) {
      throw new AudioServiceError(
        (row.error_code as AudioErrorCode) || "INVALID_AUDIO_REQUEST",
        400,
        false,
        safeSummary((row.error_code as AudioErrorCode) || "INVALID_AUDIO_REQUEST"),
      );
    }
    if (mode === "manual") return;
    if (mode === "preload") {
      throw new AudioServiceError(
        "AUDIO_RETRY_REQUIRED",
        409,
        true,
        safeSummary("AUDIO_RETRY_REQUIRED"),
        row.next_retry_at,
      );
    }
    if (row.failure_count >= AUDIO_AUTOMATIC_RETRY_LIMIT) {
      throw new AudioServiceError(
        "AUDIO_RETRY_REQUIRED",
        409,
        true,
        safeSummary("AUDIO_RETRY_REQUIRED"),
        row.next_retry_at,
      );
    }
    if (row.next_retry_at && Date.parse(row.next_retry_at) > this.now().getTime()) {
      throw new AudioServiceError(
        "AUDIO_RETRY_COOLDOWN",
        429,
        true,
        safeSummary("AUDIO_RETRY_COOLDOWN"),
        row.next_retry_at,
      );
    }
  }

  private async hit(key: string): Promise<AudioResult | undefined> {
    const row = this.row(key);
    if (row?.status !== "ready") return;
    const valid = await this.validReadyFile(key, row.relative_path, row.size_bytes);
    if (!valid) {
      this.markStale(key);
      return;
    }
    this.deps.database
      .prepare("UPDATE audio_cache SET last_accessed_at=? WHERE cache_key=?")
      .run(this.now().toISOString(), key);
    return {
      cacheKey: key,
      url: `/api/audio/${key}`,
      cacheHit: true,
      sizeBytes: row.size_bytes ?? 0,
      provider: "kokoro",
      status: "ready",
    };
  }

  private async validReadyFile(
    key: string,
    relativePath: string | null,
    expectedSize: number | null,
  ): Promise<boolean> {
    try {
      const file = join(this.root, relativePath || `${key}.wav`);
      const metadata = await stat(file);
      if (metadata.size <= 44 || (expectedSize !== null && metadata.size !== expectedSize)) {
        return false;
      }
      const bytes = await readFile(file);
      return validWav(bytes);
    } catch {
      return false;
    }
  }

  private markStale(key: string) {
    const now = this.now().toISOString();
    this.deps.database
      .prepare(
        `UPDATE audio_cache
         SET status='stale',retryable=1,error_code='AUDIO_STORAGE_FAILED',
             error_summary='The cached audio file is missing or invalid.',
             next_retry_at=NULL,updated_at=?
         WHERE cache_key=?`,
      )
      .run(now, key);
  }

  private async generate(
    key: string,
    text: string,
    config: AudioConfig,
    retryMode: AudioRetryMode,
  ): Promise<AudioResult> {
    if (retryMode !== "manual" && providerCircuitUntil > this.now().getTime()) {
      throw new AudioServiceError(
        "KOKORO_UNAVAILABLE",
        503,
        true,
        safeSummary("KOKORO_UNAVAILABLE"),
        new Date(providerCircuitUntil).toISOString(),
      );
    }

    await mkdir(this.root, { recursive: true });
    const now = this.now().toISOString();
    this.deps.database
      .prepare(
        `INSERT INTO audio_cache(
           cache_key,status,voice,speed,language,model_version,normalization_version,format,
           updated_at,last_attempt_at,failure_count,retryable
         ) VALUES(?,?,?,?,?,?,?,?,?,?,0,1)
         ON CONFLICT(cache_key) DO UPDATE SET
           status='generating',updated_at=excluded.updated_at,last_attempt_at=excluded.last_attempt_at,
           error_code=NULL,error_summary=NULL,next_retry_at=NULL`,
      )
      .run(
        key,
        "generating",
        config.voice,
        config.speed,
        config.language,
        config.modelVersion,
        config.normalizationVersion,
        config.format,
        now,
        now,
      );
    const tmp = join(this.root, `${key}.${process.pid}.tmp`);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), AUDIO_PROVIDER_TIMEOUT_MS);
      let response: Response;
      try {
        response = await this.fetcher(`${this.kokoroBaseUrl}/tts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            voice: config.voice,
            speed: config.speed,
            lang: config.language,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        throw new AudioServiceError(
          "KOKORO_INVALID_RESPONSE",
          503,
          true,
          safeSummary("KOKORO_INVALID_RESPONSE"),
          null,
          `HTTP_${response.status}`,
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!validWav(bytes, response.headers.get("content-type") ?? "")) {
        throw new AudioServiceError(
          "KOKORO_INVALID_WAV",
          503,
          true,
          safeSummary("KOKORO_INVALID_WAV"),
        );
      }
      try {
        await writeFile(tmp, bytes);
        await rename(tmp, join(this.root, `${key}.wav`));
      } catch (error) {
        throw classifyProviderError(error);
      }
      const done = this.now().toISOString();
      this.deps.database
        .prepare(
          `UPDATE audio_cache
           SET status='ready',relative_path=?,size_bytes=?,created_at=COALESCE(created_at,?),
               updated_at=?,last_accessed_at=?,retryable=NULL,error_code=NULL,error_summary=NULL,
               next_retry_at=NULL
           WHERE cache_key=?`,
        )
        .run(`${key}.wav`, bytes.length, done, done, done, key);
      providerCircuitUntil = 0;
      lastProviderErrorCode = null;
      await this.cleanup(key);
      return {
        cacheKey: key,
        url: `/api/audio/${key}`,
        cacheHit: false,
        sizeBytes: bytes.length,
        provider: "kokoro",
        status: "ready",
      };
    } catch (error) {
      await rm(tmp, { force: true });
      const failure = classifyProviderError(error);
      const previous = this.row(key)?.failure_count ?? 0;
      const attempt = previous + 1;
      const nextRetryAt = failure.retryable
        ? new Date(this.now().getTime() + retryDelay(attempt)).toISOString()
        : null;
      this.deps.database
        .prepare(
          `UPDATE audio_cache
           SET status='failed',failure_count=?,retryable=?,error_code=?,error_summary=?,
               next_retry_at=?,updated_at=?
           WHERE cache_key=?`,
        )
        .run(
          attempt,
          failure.retryable ? 1 : 0,
          failure.code,
          failure.safeSummary,
          nextRetryAt,
          this.now().toISOString(),
          key,
        );
      if (failure.code === "KOKORO_UNAVAILABLE" || failure.code === "KOKORO_TIMEOUT") {
        providerCircuitUntil = this.now().getTime() + retryDelay(attempt);
        lastProviderErrorCode = failure.code;
      }
      throw new AudioServiceError(
        failure.code,
        failure.httpStatus,
        failure.retryable,
        failure.safeSummary,
        nextRetryAt,
        failure.causeCode,
      );
    }
  }

  private async cleanup(protect: string) {
    const rows = this.deps.database
      .prepare(
        `SELECT cache_key,size_bytes,last_accessed_at,status
         FROM audio_cache WHERE size_bytes IS NOT NULL`,
      )
      .all() as Array<{
      cache_key: string;
      size_bytes: number;
      last_accessed_at: string | null;
      status: string;
    }>;
    for (const key of cleanupPlan(rows, this.deps.limit ?? AUDIO_CACHE_LIMIT, protect)) {
      try {
        await rm(join(this.root, `${key}.wav`), { force: true });
        this.deps.database.prepare("DELETE FROM audio_cache WHERE cache_key=?").run(key);
      } catch {
        // Cleanup failure must not invalidate newly generated audio.
      }
    }
  }
}
