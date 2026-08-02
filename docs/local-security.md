# Local security contract

Personal English Lab is a single-user, single-process, local-first application. It is supported only
when Next.js and Kokoro bind to loopback. This hardening reduces accidental exposure and cross-origin
browser writes; it is not authentication and does not make the app safe for LAN or internet hosting.

## Network boundary

Official `dev`, `start`, desktop, and standalone launchers bind Next.js to `127.0.0.1`. Kokoro accepts
only `127.0.0.1` or `localhost`; its base URL must be loopback HTTP. Port conflicts stop startup with
a clear error instead of creating another uncontrolled instance.

Mutation routes validate the `Host` header against `127.0.0.1`, `localhost`, or `::1` with any valid
local app port. When `Origin` is present it must be the exact same local host and port. Requests from
local server tools may omit `Origin`. Read-only GET routes keep their existing behavior. These checks
are a local boundary, not an identity system.

## JSON limits

All JSON mutation routes use one streaming bounded reader with a five-second body read timeout. It
checks `Content-Length` when present and still enforces the limit while streaming when it is absent.

| Operation              |                                             Maximum body |
| ---------------------- | -------------------------------------------------------: |
| Speaking commands      |                                                   64 KiB |
| Listening commands     |                                                   32 KiB |
| Sentence check         |                                                    4 KiB |
| Lesson generation      |             64 KiB; transcript maximum 14,000 characters |
| Practice feedback      |     32 KiB; fields also have individual character limits |
| Audio prepare          |                                             10,000 bytes |
| Audio cache action     |                                              1,000 bytes |
| Lesson/progress writes |                                          1,000,000 bytes |
| Legacy migration       |                                          8,000,000 bytes |
| Backup import          | 8,064,000 bytes, preserving the existing backup contract |

`415` means the request is not `application/json`; `413` means the body is too large; `400` means
malformed JSON or invalid framing; `403` means the local Host/Origin contract failed.

## Expensive operations

Gemini generation, feedback, and sentence checks share a process-local admission gate: two active
operations and four bounded waiters. The wait queue times out after 15 seconds. Audio synthesis stays
concurrency one, coalesces identical keys, and admits at most 24 queued keys. Capacity rejection is
`429`; queue wait timeout/unavailability is `503`.

The Gemini key is sent in the `x-goog-api-key` header, never in the URL. Calls time out after 20
seconds and provider responses are bounded to 2 MiB. Client responses and logs contain safe codes,
HTTP status, and lengths only—not provider bodies, API keys, transcripts, or learner answers.

## Kokoro HTTP contract

Kokoro has no CORS headers and `OPTIONS /tts` returns `405`; browsers call the internal Next audio API.
`POST /tts` requires `application/json` with `Content-Length`, is limited to 12 KiB, and has a
five-second socket/read timeout. Text is rejected above 650 normalized characters or 2,600 UTF-8
bytes. Supported runtime config is `af_sarah`, `en-us`, speed `0.65..1.35`, model
`kokoro-v1.0`, normalization version `1`, and WAV output.

The HTTP server permits at most 16 request threads and four validated `/tts` requests waiting/running;
actual `Kokoro.create()` concurrency remains one. Overflow is rejected quickly, health remains
responsive, and all semaphore/lock paths release on error. Safe logs contain request ID, text length,
short text hash, duration, status, and error code—never full text.

Kokoro status meanings: malformed JSON `400`, unsupported media `415`, oversized body `413`, invalid
field `422`, capacity `429`, model unavailable `503`, read timeout `504`, and synthesis failure `500`.

## Dependencies and CI

Next.js and `eslint-config-next` are pinned together. CI uses Node 24, performs install, format, lint,
tests, build, every storage/backup/audio/Speaking/Listening/security/Kokoro smoke, then the production
audit policy. New High/Critical advisories fail the gate. The temporary waiver in
`tools/audit_policy.mjs` is exact-ID, explains exposure, and expires on 2026-09-30; it must not be
replaced with `|| true`.

## Troubleshooting

- `403`: use the official `http://127.0.0.1:<port>` or `http://localhost:<port>` origin.
- `413`: reduce the request; lesson transcripts are rejected rather than silently truncated.
- `415`: send `Content-Type: application/json` (optional UTF-8 charset is accepted).
- `422`: correct the field value; audio configuration is strict and is never silently clamped.
- `429`: an expensive local queue is full; wait briefly and retry from the UI.
- `503`: provider/model is unavailable, a bounded wait expired, or the supported local port is busy.

Do not bind either service to `0.0.0.0`, publish a LAN URL, place it behind a public proxy, or treat
Host validation as authentication.
