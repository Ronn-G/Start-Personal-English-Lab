# Background audio cache (Sprint 5)

Opening one lesson renders immediately, selects at most 15 unique English items, then queues preparation in the background. Priority is user click (0), visible content (1), shadowing (2), example sentences (3), sentence mining (4), vocabulary context (5), other preload (6). The initial plan includes up to five shadowing lines, five examples, three mining sentences and five vocabulary contexts; Vietnamese meanings, titles, summaries, quiz answers and long text are excluded.

The browser queue has concurrency 1 and coalesces the same canonical request. Leaving a lesson cancels low-priority queued work; Strict Mode duplicate enqueue shares one promise. Preload never plays audio. A click promotes/coalesces the job and plays only after that user action. If Kokoro generation fails, `window.speechSynthesis` is used explicitly as an uncached browser fallback.

The SHA-256 cache key covers whitespace-normalized (case-preserved) text, voice, speed, language, Kokoro model version, normalization version and WAV format. Files are named only by the key and live in `<PERSONAL_ENGLISH_LAB_DATA_DIR>/audio-cache` (`.data/audio-cache` in development and Local AppData for portable Windows). The client sees only `/api/audio/<key>`, never a path.

SQLite schema v5 stores status and operational metadata in `audio_cache`, never WAV blobs or full text. Generation validates input, locks per key in the local Node process, marks generating, calls loopback Kokoro with a 30-second timeout, validates content type/size/RIFF-WAVE header, writes a `.tmp` file, atomically renames it, then marks ready. Ready metadata with a missing file becomes stale. The in-memory lock assumes the supported single local Node process.

The default limit is 500 MB. After generation, LRU cleanup removes only enough old ready entries, excluding generating and newly-created audio. Cleanup failure does not invalidate the new audio. The lesson UI shows ready/total progress plus cache file count/size and offers a confirmed clear action. Clearing audio does not touch lessons, progress, imports, database or legacy localStorage.

Audio files and `audio_cache` metadata are excluded from backup v1; restore does not delete reusable text-keyed cache. Portable launch already assigns the same writable Local AppData directory to SQLite and audio cache, and build packaging does not copy that directory. Concurrency 2, cache size/voice UI, multi-process locking, low-end hardware throughput and a clean extracted ZIP remain unbenchmarked/unverified. For `KOKORO_UNAVAILABLE` or timeout, verify `http://127.0.0.1:5050/health`, model paths and launcher logs.

# Speaking preload

Guided Speaking Ladder preloads only the current and next sentence with background priority. It passes the same normalized text and audio configuration used elsewhere, without step or practice IDs in the cache key. Playback and Web Speech fallback still require an explicit user click; preload failure never blocks practice.
