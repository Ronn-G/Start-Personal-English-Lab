import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  AUDIO_DEFAULTS,
  canonicalAudioInput,
  normalizeAudioText,
  type AudioConfig,
} from "../../lib/audio-domain";
import { resolveDataDirectory } from "../storage/data-directory";
export const AUDIO_CACHE_LIMIT = 500 * 1024 * 1024;
const locks = new Map<string, Promise<AudioResult>>();
export interface AudioResult {
  cacheKey: string;
  url: string;
  cacheHit: boolean;
  sizeBytes: number;
}
export interface AudioDeps {
  database: DatabaseSync;
  root?: string;
  fetcher?: typeof fetch;
  limit?: number;
}
export function audioCacheKey(text: string, config: AudioConfig): string {
  return createHash("sha256").update(canonicalAudioInput(text, config)).digest("hex");
}
export function validWav(data: Uint8Array, type = "audio/wav") {
  return (
    type.includes("audio") &&
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
  let total = rows.reduce((n, x) => n + x.size_bytes, 0);
  const remove: string[] = [];
  for (const row of [...rows]
    .filter((x) => x.status === "ready" && x.cache_key !== protect)
    .sort((a, b) => (a.last_accessed_at ?? "").localeCompare(b.last_accessed_at ?? ""))) {
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
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("INVALID_KOKORO_BASE_URL");
  return url.toString().replace(/\/+$/, "");
}

export class AudioCacheService {
  private root: string;
  private fetcher: typeof fetch;
  private kokoroBaseUrl: string;
  constructor(private deps: AudioDeps) {
    this.root = deps.root ?? join(resolveDataDirectory(), "audio-cache");
    this.fetcher = deps.fetcher ?? fetch;
    this.kokoroBaseUrl = resolveKokoroBaseUrl();
  }
  async prepare(text: string, partial: Partial<AudioConfig> = {}): Promise<AudioResult> {
    const normalized = normalizeAudioText(text);
    if (!normalized || normalized.length > 650) throw new Error("INVALID_TEXT");
    const config = { ...AUDIO_DEFAULTS, ...partial } as AudioConfig;
    const key = audioCacheKey(normalized, config);
    const hit = await this.hit(key);
    if (hit) return hit;
    const locked = locks.get(key);
    if (locked) return locked;
    const work = this.generate(key, normalized, config).finally(() => locks.delete(key));
    locks.set(key, work);
    return work;
  }
  async read(key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("INVALID_CACHE_KEY");
    const hit = await this.hit(key);
    if (!hit) throw new Error("FILE_MISSING");
    return readFile(join(this.root, `${key}.wav`));
  }
  async info() {
    const row = this.deps.database
      .prepare(
        "SELECT COUNT(*) count,COALESCE(SUM(size_bytes),0) bytes FROM audio_cache WHERE status='ready'",
      )
      .get() as { count: number; bytes: number };
    return row;
  }
  async clear() {
    await mkdir(this.root, { recursive: true });
    const rows = this.deps.database
      .prepare("SELECT cache_key FROM audio_cache WHERE status!='generating'")
      .all() as { cache_key: string }[];
    for (const row of rows) await rm(join(this.root, `${row.cache_key}.wav`), { force: true });
    this.deps.database.prepare("DELETE FROM audio_cache WHERE status!='generating'").run();
    return this.info();
  }
  private async hit(key: string): Promise<AudioResult | undefined> {
    const row = this.deps.database
      .prepare("SELECT status,size_bytes FROM audio_cache WHERE cache_key=?")
      .get(key) as { status: string; size_bytes: number } | undefined;
    if (row?.status !== "ready") return;
    try {
      await stat(join(this.root, `${key}.wav`));
      this.deps.database
        .prepare("UPDATE audio_cache SET last_accessed_at=? WHERE cache_key=?")
        .run(new Date().toISOString(), key);
      return { cacheKey: key, url: `/api/audio/${key}`, cacheHit: true, sizeBytes: row.size_bytes };
    } catch {
      this.deps.database
        .prepare(
          "UPDATE audio_cache SET status='stale',error_code='FILE_MISSING',updated_at=? WHERE cache_key=?",
        )
        .run(new Date().toISOString(), key);
    }
  }
  private async generate(key: string, text: string, c: AudioConfig): Promise<AudioResult> {
    await mkdir(this.root, { recursive: true });
    const now = new Date().toISOString();
    this.deps.database
      .prepare(
        "INSERT INTO audio_cache(cache_key,status,voice,speed,language,model_version,normalization_version,format,updated_at,failure_count) VALUES(?,?,?,?,?,?,?,?,?,0) ON CONFLICT(cache_key) DO UPDATE SET status='generating',updated_at=excluded.updated_at,error_code=NULL",
      )
      .run(
        key,
        "generating",
        c.voice,
        c.speed,
        c.language,
        c.modelVersion,
        c.normalizationVersion,
        c.format,
        now,
      );
    const tmp = join(this.root, `${key}.${process.pid}.tmp`);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      let response: Response;
      try {
        response = await this.fetcher(`${this.kokoroBaseUrl}/tts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, voice: c.voice, speed: c.speed, lang: c.language }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw new Error("KOKORO_UNAVAILABLE");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!validWav(bytes, response.headers.get("content-type") ?? ""))
        throw new Error("INVALID_WAV");
      await writeFile(tmp, bytes);
      await rename(tmp, join(this.root, `${key}.wav`));
      const done = new Date().toISOString();
      this.deps.database
        .prepare(
          "UPDATE audio_cache SET status='ready',relative_path=?,size_bytes=?,created_at=COALESCE(created_at,?),updated_at=?,last_accessed_at=?,error_code=NULL WHERE cache_key=?",
        )
        .run(`${key}.wav`, bytes.length, done, done, done, key);
      await this.cleanup(key);
      return { cacheKey: key, url: `/api/audio/${key}`, cacheHit: false, sizeBytes: bytes.length };
    } catch (e) {
      await rm(tmp, { force: true });
      this.deps.database
        .prepare(
          "UPDATE audio_cache SET status='failed',failure_count=failure_count+1,error_code=?,updated_at=? WHERE cache_key=?",
        )
        .run(
          String(e).includes("Abort") ? "TIMEOUT" : String(e).slice(0, 60),
          new Date().toISOString(),
          key,
        );
      throw e;
    }
  }
  private async cleanup(protect: string) {
    const rows = this.deps.database
      .prepare(
        "SELECT cache_key,size_bytes,last_accessed_at,status FROM audio_cache WHERE size_bytes IS NOT NULL",
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
      } catch {}
    }
  }
}
