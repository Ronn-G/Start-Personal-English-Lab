# Immersion Listening Loop v1

The lesson flow now starts with listening before the existing Guided Speaking Ladder:

`First Listen → Check Meaning → Second Listen → Sentence Review → Final Re-listen → Complete`

The user starts or resumes one active listening session per lesson. Practice Again cancels only an
unfinished active session, creates a new session, and keeps completed session history plus aggregate
sentence counters. Listening completion never changes Speaking Ladder completion.

## Content and audio

Lesson v1 does not have stable transcript-segment records. Listening v1 therefore derives practice
items from existing stable UUIDs in shadowing lines, example sentences, sentence-mining items and
vocabulary contexts. The stable listening ID contains normalization version 1, lesson UUID, source
type and source item UUID. Display order and timestamps are not part of identity.

If a stored lesson has source transcript metadata, First/Second/Final Listen use a bounded excerpt;
older lessons fall back to a bounded track built from the stable practice sentences. Both are clearly
labelled **Kokoro practice audio** and are not presented as original YouTube audio. Sentence playback
in Check Meaning and Sentence Review uses one shared controller and one shared control component.
Both paths use the same normalized text, voice, speed, language, model, cache key, prepare request,
queue and retry behavior. Play and loop 3/5 prepare one cached URL and reuse the same resolved source
for the whole run.

Kokoro is always preferred. Queued and generating jobs stay in **Preparing Kokoro audio** and never
trigger fallback. Browser voice is allowed only after a real Kokoro prepare/media failure following
a user Play action, and the control then shows **Using browser voice**. **Retry Kokoro** never starts
browser voice. A normal `HTMLAudioElement.play()` rejection is shown as a playback failure instead
of being treated as a Kokoro provider failure. No audio starts without a user action.

Transcript reveal is session-scoped in `revealed_item_ids_json`, so reload resumes reveals but
Practice Again starts hidden. `listening_item_progress.transcript_revealed` is an aggregate history
flag for backup and review; it does not force a new session to reveal content.

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

## Manual check

Open an old lesson, start listening, confirm the transcript is hidden, save First Listen, reveal one
sentence, play and loop it, reload and continue, then complete Second Listen and Final Re-listen.
Exercise shadowing, example, sentence-mining and vocabulary-context items. Confirm every Play shows
preparing, Kokoro ready/playing, browser fallback or failed; force a Kokoro failure and verify the
visible browser status and Kokoro-only retry. Save and remove a sentence, reload, verify Re-listen
and lesson isolation, and open the matching Speaking Ladder item. Export/import both a current
backup and a legacy backup without `savedForRelisten`; listening and speaking must remain separate.
Check the browser console and confirm no audio plays automatically.
