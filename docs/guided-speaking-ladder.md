# Guided Speaking Ladder

Guided Speaking Ladder moves learners from reading a saved sentence to recalling it, speaking from
keywords, personalizing it, and adding an unscripted sentence. It does not use a microphone, record
speech, recognize speech, or assign pronunciation or speech-quality scores.

Candidates come from shadowing lines, example sentences, sentence-mining sentences, then vocabulary
contexts. Stable identity combines the normalization version, lesson ID, source type, and source item
ID. Duplicate, fragmentary, and overly long candidates are excluded.

## State machine and subsets

`SpeakingService` owns all queries and mutations. Routes only parse JSON, validate the command shape,
invoke the service, and map domain errors to HTTP.

The full ladder is:

```text
Read -> Recall -> Keywords -> Personalize -> Free Speak
```

The server computes the only next step. A client-supplied target cannot skip or backtrack. Non-final
tasks stop at Personalize. Every non-empty full, targeted, review, or daily subset assigns Free Speak
to exactly its final task; it is not added to every task.

## Transactions, concurrency, and immutability

SQLite schema v12 stores a non-negative session `revision`. Every item mutation binds to lesson ID,
session ID, stable practice item ID, current item index, current step, and expected revision. Inside a
`BEGIN IMMEDIATE` transaction the service reloads the active row, validates the binding and source,
performs a conditional update, and requires exactly one changed row before updating progress and
checking backup capacity. Any failure rolls back the whole command.

Successful ladder/session mutations increment revision once. A stale request returns `409 CONFLICT`,
does not change counters, and makes the UI reload the latest state. This revision-based design is the
idempotency mechanism for advance, reveal, draft, and completion commands.

Completed and cancelled sessions are immutable. Start New, Practice Again, targeted practice, and
Review cancel the old active session and insert the replacement in one transaction. If insertion or
backup validation fails, the old session remains active.

## Counters and ratings

`revealed_item_ids_json` records Show Answer use by item within a session. The first reveal increments
`help_count` and `show_answer_count`; later clicks/retries do not. Completing/rating an item is allowed
only at that task's final step, increments `attempt_count` once, and derives help from the persisted
reveal marker rather than a client boolean. Hard/Okay/Easy records how easily the learner spoke the
item, not grammar quality.

Review and daily selection exclude soft-deleted lessons and use the latest stored status/rating.
Cumulative historical help is not a permanent difficulty flag. A fuller mastery/due model is future
work; this sprint does not add spaced repetition.

## Draft autosave

Drafts are optional and limited to 500 characters. Each request carries the stable item binding and a
monotonic client draft version. The server writes only at Personalize, rejects older versions, and
cannot infer item B for a late item-A request. The UI debounces background saves, cancels on unmount,
flushes before advance/completion, and shows Saving/Saved/Not saved without disabling audio.

## Sentence checking

Sentence checking is optional text feedback. The provider call runs outside a database transaction.
Before the call, the service validates session, item, Personalize step, input, hash, revision, and
check version. After the provider returns, a new transaction reloads and revalidates current state,
merges into the latest checks JSON, and accepts only a newer per-item check version. Out-of-order or
otherwise stale responses return 409 and are not written. Provider failure never mutates checks or
removes a draft.

Only the original sentence, local prompt/pattern, target phrase, and user draft go to the provider.
Transcripts, full lessons, progress, backups, audio, secrets, prompts, raw provider responses, and
token metadata are not persisted as sentence-check state.

## Backup compatibility

Backup v2 exports revisions, reveal markers, draft/check versions, drafts, and validated checks so an
active session resumes faithfully. Those concurrency fields remain optional when importing older v2
files and default safely. Merge never lowers session revision/status or progress counters. Backup v1
and earlier v2 files remain readable.

## UI and acceptance

Mutation controls use a command-level busy guard, `aria-busy`, checked `response.ok`, and
`try/catch/finally`. Conflicts reload state and show a neutral message. Audio remains available when a
background draft save does not conflict.

Run `npm.cmd run smoke:speaking` for API/runtime coverage. Browser acceptance should verify the full
ladder, rapid double-clicks, autosave across reload/item changes, stale sentence responses, immutable
completed sessions, targeted practice, and a clean console.

Current limitations: no recording, speech recognition, pronunciation scoring, cloud sync, or full
spaced-repetition scheduler.
