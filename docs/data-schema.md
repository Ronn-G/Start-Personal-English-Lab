# Data schemas (Sprint 2)

Sprint 5 raises SQLite to **5** with `audio_cache`; WAV data and raw text are not stored in SQLite. Backup remains independently versioned at 1 and deliberately ignores this operational table.

Sprint 4 adds a fourth independent version: backup format **1** (`CURRENT_BACKUP_VERSION`). SQLite is now **4**; Lesson and Progress remain **1**. Schema v4 adds `import_receipts(import_id, imported_at, source_fingerprint, mode, lesson_count, progress_count, result, warning_count)` and stores no backup blob.

Four independent integer versions exist: SQLite database **5** (`PRAGMA user_version`), backup format **1** (`CURRENT_BACKUP_VERSION`), Lesson document **1** (`CURRENT_LESSON_SCHEMA_VERSION`), and Lesson progress **1** (`CURRENT_PROGRESS_SCHEMA_VERSION`).

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
