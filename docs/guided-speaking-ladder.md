# Guided Speaking Ladder (Sprint 6)

Guided Speaking Ladder moves learners from reading a saved sentence to recalling it, speaking from keywords, personalizing it, and adding an unscripted sentence. It uses local deterministic rules only; it does not call AI, require a microphone, record speech, or assign a pronunciation or grammar score.

Candidates are selected from shadowing lines, useful example sentences, sentence-mining sentences, then vocabulary contexts. Shadowing markup is normalized for display and audio. Duplicate, fragmentary, and overly long sentences are excluded. Identity is derived from normalization version, lesson ID, source type, and the stable source item ID.

The five steps are Read, Recall, Keywords, Personalize, and Free Speak. Recall masks a target phrase when available. Keywords retain only a small set of content cues. Personalize uses a conservative local pattern or a change-one-part fallback. At least one item in a non-empty session includes Free Speak.

Speaking storage was finalized in SQLite schema v7; the current database schema is v11. Per-item
status, monotonic counters, explicit self-rating and timestamps remain in `speaking_progress`.
`speaking_sessions` stores lesson/item references and the current item/step. Version 7 safely repairs
databases created by an intermediate Sprint 6 build that omitted draft/check or source-item columns.
A partial unique index permits one active session per lesson, so repeated Start requests coalesce and
a partial session resumes.

Audio continues to use `SpeakButton` and the Sprint 5 cache. Playback requires a click; the sentence is passed without ladder state, so cache identity remains text/voice/speed/language based. Audio failure does not prevent advancing.

Current limitations: no speech recognition, recording, AI feedback, pronunciation scoring, cloud sync, or full spaced-repetition scheduler.

Lesson entry labels come from persisted state: Start, Continue with item progress, or Practice Again. The dashboard's Practice Speaking action selects an active session first, then difficult progress, then a recent eligible lesson. Completion summarizes help, personalization, Free Speak, ratings, and review phrases; difficult review creates a focused session.

Run `npm.cmd run smoke:speaking` for focused speaking domain and backup round-trip coverage. Full verification also uses `npm.cmd test`, lint, build, storage, backup, and audio smoke scripts.

## Browser acceptance checklist

Run `npm.cmd run dev`, open `http://localhost:3000` in Chrome or Edge, and use DevTools Console to check for serious errors. Verify: Start from a lesson; audio plays only after click; Read, Recall, Show Answer, Keywords, and Personalize are clear; Personalize shows an original, a blank pattern or fallback, topic prompts, and rating guidance; Free Speak supplies no complete answer; exiting then refreshing continues at the same item and step; completion summary is correct; Review Difficult Items and Practice Again work; dashboard Practice Speaking chooses a lesson; a lesson without candidates shows the empty state; no audio autoplays.

Manual acceptance status: **Pending user verification on Chrome/Edge**.

## Personal sentence drafts and checking

Writing a personal sentence is optional; the main goal remains saying it aloud. Drafts are stored server-side with the current session/item (maximum 500 characters), survive refresh/exit, and never overwrite lesson content or trigger audio/AI automatically. **Check my sentence** is optional and calls the existing Gemini provider only after a click. It sends only the current original, local question/pattern, target phrase, and draft—not the transcript, full lesson, progress, backup, audio, or secrets.

The response separates a minimal corrected sentence from an optional natural spoken alternative and gives a short Vietnamese explanation. Editing the draft marks old feedback stale. Drafts and validated feedback are included in backup session data; prompts, raw provider responses, API keys, and token metadata are not. Provider failure never removes the draft or blocks speaking/self-rating. Hard/Okay/Easy rates speaking ease, not grammar quality.
