# Data schemas

Four independent integer versions exist: SQLite database **13** (`PRAGMA user_version`), backup
format **2** (`CURRENT_BACKUP_VERSION`), Lesson document **1**
(`CURRENT_LESSON_SCHEMA_VERSION`), and Lesson progress **1**
(`CURRENT_PROGRESS_SCHEMA_VERSION`). Backup v1 remains readable for recovery compatibility.

Schema v4 added compact `import_receipts`; v5 added operational `audio_cache`. WAV data, raw audio,
secrets, and machine paths are never part of either backup version.

## Lesson v1 and stable IDs

`Lesson` owns `id`, `schemaVersion`, `createdAt`, `updatedAt` and all learning content. Stable UUIDs exist on vocabulary, idiom/slang, example sentence, quiz question, shadowing line, sentence-mining item and Anki card. Valid IDs survive normalization. Missing, invalid or duplicate IDs are assigned/repaired once by the app; AI is not trusted to generate them. Duplicate detection spans the whole lesson.

The shared client-compatible pipeline in `src/lib/lesson-schema.ts` is:

```text
raw text -> strip fences -> JSON parse -> legacy-version check -> immutable migration
-> assign/repair IDs -> canonical validation -> typed result + diagnostics
```

Manual paste and automatic Gemini generation both use it. Malformed JSON is never silently rewritten. Legacy v0 normalization prefers wrapper timestamps; without one it uses fixed fallback `1970-01-01T00:00:00.000Z`, so repeated reads do not invent time. Sprint 3 persists each successfully normalized result transactionally before treating generated IDs as durable.

## Progress v1

`LessonProgress` contains `lessonId`, `progressVersion`, ID-keyed `quizItems`/`learningItems`, `visitedSections`, extensible `practiceHistory`, and timestamps. Quiz state includes selected answer, correctness, attempt count, answered time and completion. Learning state includes `new | learning | learned`, update time and user-selected flag. Practice history stores metadata/feedback, never audio.

Progress uses IDs because indexes change when lesson arrays are reordered. Lesson content describes what is taught; progress separately describes user interaction.

`migrateLegacyProgress()` is pure. With the matching canonical Lesson it deduplicates legacy quiz indexes, maps valid indexes to quiz IDs, and warns/skips wrong-type or out-of-range values without writing storage.

## Database, boundaries and future versions

SQLite still stores whole documents in `lesson_json` and `progress_json`; item tables remain out of scope. Migration 2 transactionally normalizes version-1 database payloads to canonical documents while retaining unknown legacy fields. Repository reads/writes validate canonical documents and preserve IDs. Databases newer than v2 are rejected.

To add a version: increment the relevant integer, add an immutable `vN -> vN+1` migration, retain diagnostics/fixtures for supported inputs, and update producers, validators, repository tests and this document. Database and document versions must never be conflated.

Schema v3 adds `legacy_migration_items` for the idempotent localStorage migration receipt. Sprint 3 previews, transactionally persists, reads back, validates, and only then records completion in `app_metadata`. Legacy lesson/progress keys are not deleted or overwritten. Vocabulary flips and historical speaking feedback remain outside this sprint.

# Sprint 6 speaking tables

Schema v6 adds `speaking_progress`, keyed by `(lesson_id, practice_item_id)`. It stores source type/item identity, ranked status, monotonic attempts/help/show-answer/recall/personalization counters, explicit self-rating, and practice timestamps. `speaking_sessions` stores item references, current index/step, status, and lifecycle timestamps. A partial unique index allows one active session per lesson.

# Personal sentence state

Schema v6 uses `speaking_sessions.drafts_json` for optional user-written drafts and `checks_json` for validated sentence-check results plus input hash/time. Both are session/item scoped and never modify lesson JSON.

# Speaking correctness and concurrency (schema v12)

Schema v12 adds `revision`, `revealed_item_ids_json`, `draft_versions_json`, and
`check_versions_json` to `speaking_sessions`, with non-negative/JSON CHECK constraints and a
conditional-mutation index. Existing rows migrate with revision `0`, empty reveal markers, and empty
version maps. Lesson and Progress document versions do not change.

Session revision protects ladder, reveal, draft, rating, and completion mutations. Draft/check
versions additionally order asynchronous item-scoped writes. Mutations validate active status,
stable current item identity, expected index/step, lesson/source identity, and concurrency tokens
inside a transaction. Completed/cancelled rows cannot be mutated.

# Sprint 8 learning activity in Progress v1

Không tăng SQLite hoặc Progress schema version. Các field JSON vốn có được hoàn thiện:

- `learningItems[itemId]`: vocabulary UUID, trạng thái `learned`, `userSelected: true` và `updatedAt`
  khi người dùng chủ động lật thẻ.
- `visitedSections`: union các key cố định `vocabulary | idioms | grammar | practice | quiz`; đây là
  “đã xem”, không phải mastery/completion.
- `practiceHistory`: record UUID gồm example-sentence UUID, mode writing/speaking, prompt, user
  answer, typed feedback và timestamp. Tối đa 20 record mới nhất mỗi lesson.

Parser progress mặc định ba collection trên thành `{}`, `[]`, `[]` khi document v1 cũ thiếu field.
Command validation kiểm tra item thuộc lesson, enum, timestamp, UUID, feedback shape và giới hạn
string. SQLite repository áp dụng command bằng read-modify-write transaction.

Routine Progress transactions validate this document and its lesson bindings but do not measure a
full backup. Backup v2's 8,000,000-byte ceiling is an export/import artifact boundary, independent
from SQLite capacity. Source transcripts remain limited per field to 2,000,000 characters and
4,000,000 UTF-8 bytes; lesson/progress JSON, Listening notes, Speaking drafts, and sentence checks
retain their own bounded validators.

# Immersion Listening Loop tables

Schemas v8-v10 introduced Listening, Re-listen bookmarks, and typed audio failures. Lesson and
Progress remain version 1.

Schema v8 adds `listening_sessions` and `listening_item_progress`.

- `listening_sessions` keeps one partial-unique active row per lesson, stable business step,
  self-ratings/notes, session-scoped revealed item IDs and lifecycle timestamps.
- `listening_item_progress` is keyed by `(lesson_id, listening_item_id)` with a unique source
  type/source item identity, non-negative listen/loop counters, aggregate reveal, ranked recognition,
  separate difficult flag and last-listened timestamp.
- Both tables use lesson foreign keys with cascade delete. Recent-session and difficult-review
  indexes support dashboard queries.

Migration v8 runs in the existing `BEGIN IMMEDIATE` transaction wrapper. It does not rewrite Lesson
v1, Progress v1, Speaking Ladder rows, audio-cache metadata or existing lesson/progress data.

Schema v9 adds `listening_item_progress.saved_for_relisten`, a boolean bookmark with an index for
the dashboard Re-listen query. The migration is a transactional `ALTER TABLE` with default `0`; it
does not infer bookmarks from legacy `difficult` rows and does not rebuild the table.

Schema v10 adds nullable `retryable`, `last_attempt_at`, `next_retry_at` and `error_summary` fields
plus a retry index to the existing `audio_cache` table. It retains all cache rows and WAV files.
Legacy failed rows become retryable Kokoro-unavailable entries; backup still
excludes operational audio metadata.

The current listening UI and service write only objective counters/reveal/timestamps plus the
explicit bookmark. Existing `recognition_status`, `difficult` and
`listening_sessions.final_relisten_rating` columns remain for database and backup compatibility but
are legacy/currently unused. Backup v1 exports `savedForRelisten` as an optional field. Import treats
its absence in older backups as `false`; merge preserves an explicitly newer bookmark value.

## Listening coherence snapshot (schema v13)

Schema v13 uses transactional `ALTER TABLE` statements to extend `listening_sessions` with bounded
`selected_item_ids_json`, `selected_items_json`, `listening_track`, `track_hash`,
`lesson_content_hash`, and `selection_version` columns. CHECK constraints cap JSON/track/hash sizes
and versions. The migration deterministically backfills active and completed v12 rows from their
stored lesson JSON. Legacy reveal IDs are intersected with the selected snapshot in canonical
snapshot order, so a historical Reveal All cannot leave hidden IDs in the migrated session. Any
invalid lesson or failed backfill rolls the migration back to v12.

The selected item objects contain stable lesson/source identity plus the exact text/context required
to finish an active session after a lesson edit. They do not duplicate the whole Lesson document.
The ordered track is exactly the selected text joined with punctuation preserved. Source availability
is resolved separately against the current lesson and never mutates the snapshot.

Backup format remains v2. The snapshot extension is optional when validating an older v2 document;
import deterministically backfills absent fields. Export and Replace preserve it exactly. Merge remaps
lesson/listening IDs while preserving ordered text/track semantics. Partial or inconsistent snapshots
are rejected at the snapshot JSON path.

# Backup v2 and Speaking integrity (Sprint: Backup Integrity v2)

Backup v2 adds required `lessonSources`, one exact snapshot per stable lesson ID. The snapshot maps
to the existing `lessons.source_title`, `source_url`, `source_channel`, `original_transcript`,
`processed_transcript`, and `was_truncated` columns; no source field or author column is invented.
`updatedAt` records snapshot recency for atomic newest-wins Merge policy. Backup v1 imports with an
empty-source warning and explicit null/false defaults.

SQLite schema v11 safely rebuilds only `speaking_progress` and `speaking_sessions` in the migration
transaction. It validates old rows before DDL, copies all columns, and recreates primary keys,
foreign keys, the last-practiced index, the one-active-session partial unique index, and the active
session index. New CHECK constraints enforce non-negative Speaking counters and current item index,
the source/status enums, and the five existing ladder steps. Invalid legacy data aborts and rolls
the migration back to v10 unchanged. No Speaking Ladder transition behavior changes in v11.
