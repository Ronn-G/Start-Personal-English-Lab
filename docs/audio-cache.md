# Kokoro audio lifecycle and cache

Kokoro is a loopback-only Node-to-Python provider. It does not emit CORS headers and browsers must
use `/api/audio/*`. `/tts` accepts only bounded JSON with canonical `af_sarah`, `en-us`, speed
`0.65..1.35` and WAV config; invalid explicit values are rejected rather than defaulted or clamped.
The HTTP layer bounds request threads and admitted TTS work while `Kokoro.create()` remains
concurrency one. See [local security](local-security.md) for limits and safe status codes.

All learning surfaces use the same canonical stack:

`SpeakButton / Listening / Re-listen -> useAppAudio -> audioClient -> /api/audio/prepare -> AudioCacheService -> Kokoro`

The canonical request includes normalized, case-preserved text, voice, speed, language, model
version, normalization version and WAV format. Its SHA-256 key is shared across vocabulary, idioms,
grammar, examples, shadowing, sentence mining, listening, Speaking Ladder and Re-listen. Files live
in `<PERSONAL_ENGLISH_LAB_DATA_DIR>/audio-cache`; the browser only sees `/api/audio/<key>`.

## Startup and health

Create an ignored `.env.local` from the Kokoro placeholders in `.env.example`. `npm run dev:full`
validates Python, model and voices, reuses a healthy service or starts one, waits for model-ready
health, then starts Next.js. `npm run tts:kokoro` starts only TTS. Port 5050 must be free or already
serve a healthy Kokoro instance.

Direct provider health is `http://127.0.0.1:5050/health`. App-safe health is
`GET /api/audio/health`; it returns configured/reachable/status/checkedAt and a safe error code,
without paths, secrets, stacks or raw exceptions.

## Concurrency and playback

The browser queue and the process-wide server synthesis queue use concurrency 1 and coalesce the
same key. The server queue protects requests coming from different components or tabs and continues
after a failed job. `tools/kokoro_server.py` keeps `ThreadingHTTPServer` responsive but guards
`Kokoro.create()` with one context-managed lock because Kokoro/phonemizer native state is not
thread-safe. Request parsing, validation, health and HTTP response writing remain outside the lock.
The local HTTP server keeps a bounded connection backlog above the expected app batch size, so
simultaneous sockets wait for request threads instead of being refused before they reach the lock.

Only `useAppAudio` creates `HTMLAudioElement` or uses Web Speech. It owns stop, pause, loops,
unmount cleanup and a module-wide playback arbiter. A loop reuses one resolved URL/source and does
not prepare again.

Kokoro is preferred. Queued/generating jobs remain **Preparing Kokoro audio**. Browser voice is
allowed only after a typed, retryable Kokoro preparation failure caused by a user Play action; the
UI then says **Using browser voice**. Cancellation, storage and media playback errors never trigger
fallback. **Retry Kokoro** performs a manual Kokoro-only prepare and does not play.

## Typed failure and recovery

Schema v10 adds `retryable`, `last_attempt_at`, `next_retry_at`, and a safe `error_summary` to the
existing `audio_cache` table. Existing rows and WAV files remain. Typed failures distinguish
provider unavailable, timeout, invalid HTTP response, invalid WAV, invalid request, cancellation,
storage and browser media playback.

Automatic retry uses bounded exponential cooldown and stops after five failures. Preload never
retries a known failed key, so background work cannot create a retry storm. Manual Retry Kokoro
bypasses cooldown and the automatic limit while retaining the same cache key. A successful retry
changes the existing entry to `ready`.

Ready files are verified by size and RIFF/WAVE bytes. **Repair invalid entries** marks only missing
or corrupt ready entries stale; the next explicit retry/play regenerates them. Clearing the whole
cache is not a normal troubleshooting step.

The diagnostics UI shows Kokoro health, active/queued synthesis, concurrency, ready/failed counts,
the latest safe error code and invalid-file repair.

## Troubleshooting

- Port 5050 closed: run `npm run dev:full`, then use `Test-NetConnection 127.0.0.1 -Port 5050`.
- Kokoro unavailable or `fetch failed`: verify `.env.local`, direct `/health`, and launcher logs.
- Timeout: wait for the current serialized job to finish, check service load, then Retry Kokoro.
- Old failed cache entry: start Kokoro and use Retry Kokoro; do not delete the database/cache.
- Missing/corrupt WAV: run Repair invalid entries, then Retry Kokoro.
- Browser fallback: confirm **Using browser voice**, restore Kokoro, then use Retry Kokoro.
- Service errors: inspect ignored `.logs/kokoro-dev.stderr.log`; reports should include codes, not
  full lesson text.

Audio cache files and metadata stay outside backup. Do not commit `.env.local`, `.data`, model,
WAV, log or portable artifacts.

# Speaking preload

Speaking Ladder preloads only the current and next item using the same canonical request. Preload
never plays audio and never blocks practice.
