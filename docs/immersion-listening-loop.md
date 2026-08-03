# Immersion Listening Loop v1

The lesson flow now starts with listening before the existing Guided Speaking Ladder:

`First Listen → Check Meaning → Second Listen → Sentence Review → Final Re-listen → Complete`

The user starts or resumes one active listening session per lesson. Practice Again cancels only an
unfinished active session, creates a new session, and keeps completed session history plus aggregate
sentence counters. Listening completion never changes Speaking Ladder completion.

## Immutable session snapshot

Schema v13 snapshots one deterministic, source-diverse set of at most eight valid, unique sentences
when a session starts. The row stores the ordered selected IDs, the selected source identities and
text/context, the joined track, a track hash, a lesson-content hash, and selection algorithm version

1. Check Meaning, Reveal All, Sentence Review, and all three central listens use that same snapshot.
   Display indexes are never persisted identities.

An active session is intentionally insulated from later lesson edits. Removed source text remains
playable from the snapshot, but Speaking and Re-listen actions are disabled when the current lesson
can no longer resolve that source. Updating a lesson transactionally prunes stale aggregate progress
and bookmarks without mutating active session rows. Practice Again creates a fresh snapshot from the
current lesson.

## Content and audio

Lesson v1 does not have stable transcript-segment records. Listening v1 therefore derives practice
items from existing stable UUIDs in shadowing lines, example sentences, sentence-mining items and
vocabulary contexts. The stable listening ID contains normalization version 1, lesson UUID, source
type and source item UUID. Display order and timestamps are not part of identity.

First/Second/Final Listen use exactly the selected sentences, in snapshot order, joined without
changing their punctuation. Selection stops before the canonical audio text/UTF-8 limits. The track
is labelled **Kokoro practice audio** and is not presented as original YouTube audio. Sentence playback
in Check Meaning and Sentence Review uses one shared controller and one shared control component.
Both paths use the same normalized text, voice, speed, language, model, cache key, prepare request,
queue and retry behavior. Play and loop 3/5 prepare one cached URL and reuse the same resolved source
for the whole run.

Kokoro is always preferred. Queued and generating jobs stay in **Preparing Kokoro audio** and never
trigger fallback. Browser voice is allowed only after a typed, retryable Kokoro preparation failure
following a user Play action, and the control then shows **Using browser voice**. **Retry Kokoro** never starts
browser voice. A normal `HTMLAudioElement.play()` rejection is shown as a playback failure instead
of being treated as a Kokoro provider failure. No audio starts without a user action.

Transcript reveal is session-scoped in `revealed_item_ids_json`, so reload resumes reveals but
Practice Again starts hidden. `listening_item_progress.transcript_revealed` is an aggregate history
flag for backup and review; it does not force a new session to reveal content.

Reveal All requires the ordered selected IDs from the client and validates them against the persisted
snapshot. It reveals only those IDs, creates no progress for hidden extracted items, and never changes
listen counts or bookmarks. Individual reveals likewise resolve only through the active snapshot.
Saving a sentence for Re-listen also requires active snapshot membership; dashboard removal is
allowed without an active session so a saved bookmark can always be cleared.

## Commands and rules

Check Meaning has no per-sentence assessment. It provides the simple summary, useful phrases,
sentence reveal and the shared Kokoro-first Play control before Second Listen. Sentence Review also
has no per-sentence assessment. Each card is limited to Play, Loop 3/5, Stop, Reveal sentence,
learning context, **Practice this sentence**, and the optional **Save for re-listen** bookmark.

`POST /api/listening` supports status, dashboard, start, practice again, First/Second Listen saves,
validated step advance, sentence reveal, objective listen/loop counters, explicit re-listen
bookmark changes and transactional completion. It no longer accepts recognition, understood-after-
reading or difficulty mark commands. The server resolves every lesson, session and source item from
SQLite and does not trust client-provided source identity.

- Counters are non-negative and only increment during practice; backup merge takes the maximum.
- Playing, looping, revealing, advancing or opening Speaking Ladder never writes a listening
  outcome or infers difficulty.
- `saved_for_relisten` is an explicit bookmark keyed by stable lesson/listening item identity. It
  does not change listen/loop counters or Speaking Ladder progress.
- The schema keeps legacy `recognition_status`, `difficult` and `final_relisten_rating` columns and
  backup fields for compatibility, but the current app does not write or display them.
- Completed sessions cannot be mutated or resumed as active.
- Final completion is allowed only from Final Re-listen and runs in one transaction.
- Final Re-listen completes without requiring a listening outcome rating.
- Dashboard Re-listen contains only explicitly saved sentences and supports Kokoro Play, Open
  lesson and Remove from re-listen. It does not use the legacy difficult flag.
- “Practice this sentence” resolves the same source item in Speaking Ladder and retains its stable
  speaking progress.

## Component tests and manual check

`npm run test:components` runs Vitest 4 with jsdom and Testing Library alongside the existing Node
test suite. It covers the five-step flow, snapshot reuse/resume, lesson mutation, Practice Again,
duplicate/conflict interaction handling, bookmark behavior, audio states/cleanup, and dashboard
actions. These are component tests, not full-browser E2E tests.

Use a temporary database and a production build. Open a lesson with more than eight eligible items,
start listening, record the selected IDs/track, confirm the transcript is hidden, save First Listen,
reveal one and Reveal All, reload and continue, then complete Second Listen and Final Re-listen.
Confirm the same IDs and track throughout. Edit the lesson mid-session, verify the old snapshot still
finishes safely, then confirm Practice Again uses the updated lesson.
Exercise shadowing, example, sentence-mining and vocabulary-context items. Confirm every Play shows
preparing, Kokoro ready/playing, browser fallback or failed; force a Kokoro failure and verify the
visible browser status and Kokoro-only retry. Save and remove a sentence, reload, verify Re-listen
and lesson isolation, and open the matching Speaking Ladder item. Export/import both a current
backup and a legacy backup without `savedForRelisten`; listening and speaking must remain separate.
Complete the flow by keyboard at desktop and 375 px widths, check visible focus/status announcements
and long-text wrapping, inspect the console, and confirm no audio plays automatically.
