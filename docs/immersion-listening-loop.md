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
and loop 3/5 prepare one cached URL, reuse the same audio element, and keep the existing Kokoro and
browser-voice fallback behavior. No audio starts without a user action.

Transcript reveal is session-scoped in `revealed_item_ids_json`, so reload resumes reveals but
Practice Again starts hidden. `listening_item_progress.transcript_revealed` is an aggregate history
flag for backup and review; it does not force a new session to reveal content.

## Commands and rules

`POST /api/listening` supports status, dashboard, start, practice again, First/Second Listen saves,
validated step advance, sentence reveal, listen/loop counters, recognition/difficulty marks and
transactional completion. The server resolves every lesson, session and source item from SQLite and
does not trust client-provided source identity.

- Counters are non-negative and only increment during practice; backup merge takes the maximum.
- Recognition ranks `not_started < heard < recognized`; a newer self-assessment controls the
  separate difficult flag unless recognition has reached `recognized`.
- Completed sessions cannot be mutated or resumed as active.
- Final completion is allowed only from Final Re-listen and runs in one transaction.
- The dashboard prioritizes completed lessons with difficult sentences, then recent completion.
- “Practice this sentence” resolves the same source item in Speaking Ladder and retains its stable
  speaking progress.

## Manual check

Open an old lesson, start listening, confirm the transcript is hidden, save First Listen, reveal one
sentence, play and loop it, reload and continue, complete Second Listen and Final Re-listen, then
verify Re-listen and Practice Again. Export/import a backup and confirm listening and speaking remain
separate. Check the browser console and confirm no audio plays automatically.
